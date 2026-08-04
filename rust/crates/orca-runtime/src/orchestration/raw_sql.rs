//! The raw-SQL introspection seam. Tests and tooling only — never a production
//! read or write path.
//!
//! Why it exists: the store owns its SQLite connection, and for `:memory:` there
//! is no file a second connection could attach to. Fork specs that must seed a
//! table directly, read `EXPLAIN QUERY PLAN`, or assert on `sqlite_master` have
//! no other way in. Production code always goes through a typed method.

use super::OrchestrationDb;
use orca_store::StoreError;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::ToSql;
use serde_json::{Map, Value};

fn bind_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| number.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null),
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn column_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        ValueRef::Real(number) => Value::from(number),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
    }
}

impl OrchestrationDb {
    /// Run one or more statements. With no binds the whole string runs as a
    /// batch, so multi-statement seeds work; with binds it is a single statement.
    pub fn raw_exec(&self, sql: &str, params: &[Value]) -> Result<(), StoreError> {
        let conn = self.db.connection();
        if params.is_empty() {
            conn.execute_batch(sql)?;
            return Ok(());
        }
        let binds: Vec<SqlValue> = params.iter().map(bind_value).collect();
        let refs: Vec<&dyn ToSql> = binds.iter().map(|value| value as &dyn ToSql).collect();
        conn.execute(sql, rusqlite::params_from_iter(refs))?;
        Ok(())
    }

    /// Run a query and return its rows as a JSON array of column-keyed objects.
    pub fn raw_query(&self, sql: &str, params: &[Value]) -> Result<Value, StoreError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(sql)?;
        let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
        let binds: Vec<SqlValue> = params.iter().map(bind_value).collect();
        let refs: Vec<&dyn ToSql> = binds.iter().map(|value| value as &dyn ToSql).collect();
        let mut rows = stmt.query(rusqlite::params_from_iter(refs))?;
        let mut out: Vec<Value> = Vec::new();
        while let Some(row) = rows.next()? {
            let mut object = Map::new();
            for (index, name) in columns.iter().enumerate() {
                object.insert(name.clone(), column_value(row.get_ref(index)?));
            }
            out.push(Value::Object(object));
        }
        Ok(Value::Array(out))
    }
}
