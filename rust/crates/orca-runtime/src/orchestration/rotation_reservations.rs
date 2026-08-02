//! Rotation-saga reservations (design §4, §8.3). The point of this module is the
//! claim: releasing expired rows and claiming the target happen in ONE
//! `BEGIN IMMEDIATE` transaction, because a partial unique index is only lifted
//! by a row transactionally marked released — an elapsed `reservation_expires_at`
//! does not make a constraint lapse on its own.

use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::{params, OptionalExtension, Row as SqlRow};
use serde::Serialize;

pub const ROTATION_SAGA_COLUMNS: &str =
    "id, provider, phase, source_route_key, target_route_key, target_store_key, reservation_fence, reservation_expires_at, reservation_released_at, last_error, created_at, updated_at";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewRotationReservation {
    pub id: String,
    pub provider: String,
    pub source_route_key: Option<String>,
    /// RouteKey string (§3a) — never a bare account id.
    pub target_route_key: String,
    /// StoreKey string; `None` means "no credential surface to lock", and NULLs
    /// stay distinct under the partial unique index, so they never collide.
    pub target_store_key: Option<String>,
    /// Caller's ISO stamp: when this claim stops being valid without renewal.
    pub expires_at: String,
    /// Caller's ISO "now" — the expiry sweep and the release stamp both use it,
    /// so a claim never depends on the DB and the caller agreeing about the clock.
    pub now: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RotationSaga {
    pub id: String,
    pub provider: String,
    pub phase: String,
    pub source_route_key: Option<String>,
    pub target_route_key: String,
    pub target_store_key: Option<String>,
    /// Monotonic per target. A saga that renews and finds the fence moved has
    /// lost the reservation and must stop.
    pub reservation_fence: i64,
    pub reservation_expires_at: String,
    pub reservation_released_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReservationClaim {
    Claimed { saga: RotationSaga, swept_expired: i64 },
    /// A live reservation already holds this route or store. Carries the holder so
    /// the caller can report WHICH saga owns the successor rather than just failing.
    Conflict { holder: RotationSaga },
}

impl OrchestrationDb {
    /// Sweep expired reservations and claim the target, atomically.
    pub fn claim_rotation_reservation(
        &self,
        request: &NewRotationReservation,
    ) -> Result<ReservationClaim, StoreError> {
        self.db.exec("BEGIN IMMEDIATE")?;
        match self.sweep_and_claim(request).and_then(|c| self.db.exec("COMMIT").map(|()| c)) {
            Ok(claim) => Ok(claim),
            Err(err) => {
                self.db.exec("ROLLBACK")?;
                Err(err)
            }
        }
    }

    fn sweep_and_claim(&self, request: &NewRotationReservation) -> Result<ReservationClaim, StoreError> {
        let conn = self.db.connection();
        // datetime() wraps both operands: stored stamps may be SQLite's
        // space-separated form while the caller passes ISO 'T' (the
        // get_stale_dispatches lesson — a raw string compare sorts ' ' before 'T').
        let swept = conn.execute(
            "UPDATE rotation_sagas
                SET reservation_released_at = ?1, updated_at = ?1
              WHERE reservation_released_at IS NULL
                AND datetime(reservation_expires_at) <= datetime(?1)",
            params![request.now],
        )? as i64;
        if let Some(holder) = self.live_reservation_for(&request.target_route_key, request.target_store_key.as_deref())? {
            return Ok(ReservationClaim::Conflict { holder });
        }
        let fence: i64 = conn.query_row(
            "SELECT COALESCE(MAX(reservation_fence), 0) + 1 FROM rotation_sagas WHERE target_route_key = ?1",
            params![request.target_route_key],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO rotation_sagas (id, provider, phase, source_route_key, target_route_key, target_store_key, reservation_fence, reservation_expires_at, updated_at)
             VALUES (?1, ?2, 'planned', ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                request.id, request.provider, request.source_route_key, request.target_route_key,
                request.target_store_key, fence, request.expires_at, request.now,
            ],
        )?;
        let saga = self
            .rotation_saga_by_id(&request.id)?
            .ok_or_else(|| StoreError::Message("rotation saga vanished after insert".into()))?;
        Ok(ReservationClaim::Claimed { saga, swept_expired: swept })
    }

    fn live_reservation_for(
        &self,
        target_route_key: &str,
        target_store_key: Option<&str>,
    ) -> Result<Option<RotationSaga>, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROTATION_SAGA_COLUMNS} FROM rotation_sagas
              WHERE reservation_released_at IS NULL
                AND (target_route_key = ?1 OR (?2 IS NOT NULL AND target_store_key = ?2))
              ORDER BY rowid LIMIT 1"
        ))?;
        Ok(stmt.query_row(params![target_route_key, target_store_key], row_to_rotation_saga).optional()?)
    }

    /// Release a reservation, fenced. A holder whose fence has moved on releases
    /// nothing — that is what stops a stale saga from freeing its successor's claim.
    pub fn release_rotation_reservation(&self, id: &str, fence: i64, now: &str) -> Result<bool, StoreError> {
        let released = self.db.connection().execute(
            "UPDATE rotation_sagas SET reservation_released_at = ?3, updated_at = ?3
              WHERE id = ?1 AND reservation_fence = ?2 AND reservation_released_at IS NULL",
            params![id, fence, now],
        )?;
        Ok(released == 1)
    }

    /// Extend a live reservation, fenced. `false` means the saga lost it and must stop.
    pub fn renew_rotation_reservation(
        &self,
        id: &str,
        fence: i64,
        expires_at: &str,
        now: &str,
    ) -> Result<bool, StoreError> {
        let renewed = self.db.connection().execute(
            "UPDATE rotation_sagas SET reservation_expires_at = ?3, updated_at = ?4
              WHERE id = ?1 AND reservation_fence = ?2 AND reservation_released_at IS NULL",
            params![id, fence, expires_at, now],
        )?;
        Ok(renewed == 1)
    }

    /// Advance the saga phase, fenced (`planned → … → committed`, or `needs-human`).
    pub fn advance_rotation_saga_phase(
        &self,
        id: &str,
        fence: i64,
        phase: &str,
        last_error: Option<&str>,
        now: &str,
    ) -> Result<Option<RotationSaga>, StoreError> {
        let advanced = self.db.connection().execute(
            "UPDATE rotation_sagas SET phase = ?3, last_error = COALESCE(?4, last_error), updated_at = ?5
              WHERE id = ?1 AND reservation_fence = ?2 AND reservation_released_at IS NULL",
            params![id, fence, phase, last_error, now],
        )?;
        if advanced == 0 {
            return Ok(None);
        }
        self.rotation_saga_by_id(id)
    }

    pub fn rotation_saga_by_id(&self, id: &str) -> Result<Option<RotationSaga>, StoreError> {
        let conn = self.db.connection();
        let mut stmt =
            conn.prepare(&format!("SELECT {ROTATION_SAGA_COLUMNS} FROM rotation_sagas WHERE id = ?1"))?;
        Ok(stmt.query_row([id], row_to_rotation_saga).optional()?)
    }

    /// Unreleased reservations for a provider, oldest first — startup reconciliation's
    /// input (§8.3 rolls each one forward, restores, or marks `needs-human`).
    pub fn list_live_rotation_sagas(&self, provider: Option<&str>) -> Result<Vec<RotationSaga>, StoreError> {
        let conn = self.db.connection();
        let (sql, bind): (String, Option<&str>) = match provider {
            Some(p) => (
                format!("SELECT {ROTATION_SAGA_COLUMNS} FROM rotation_sagas WHERE reservation_released_at IS NULL AND provider = ?1 ORDER BY rowid"),
                Some(p),
            ),
            None => (
                format!("SELECT {ROTATION_SAGA_COLUMNS} FROM rotation_sagas WHERE reservation_released_at IS NULL ORDER BY rowid"),
                None,
            ),
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = match bind {
            Some(p) => stmt.query_map([p], row_to_rotation_saga)?.collect::<rusqlite::Result<Vec<_>>>()?,
            None => stmt.query_map([], row_to_rotation_saga)?.collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
    }
}

pub(crate) fn row_to_rotation_saga(row: &SqlRow<'_>) -> rusqlite::Result<RotationSaga> {
    Ok(RotationSaga {
        id: row.get(0)?,
        provider: row.get(1)?,
        phase: row.get(2)?,
        source_route_key: row.get(3)?,
        target_route_key: row.get(4)?,
        target_store_key: row.get(5)?,
        reservation_fence: row.get(6)?,
        reservation_expires_at: row.get(7)?,
        reservation_released_at: row.get(8)?,
        last_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}
