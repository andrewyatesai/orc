//! `isCanonicalHttpsOrigin` from `src/shared/mobile-relay-pairing-offer.ts`.
//!
//! The twin asks `new URL(value).protocol === 'https:' && value === parsed.origin`.
//! That is not "is this a URL" — it is "is this string byte-identical to what the
//! WHATWG serializer would print", which is a far narrower set: lowercase scheme
//! and host, no path/query/fragment/userinfo, default port 443 elided, IPv4 as a
//! canonical dotted quad, IPv6 in compressed lowercase form. So this recognizes
//! that set directly rather than re-implementing the parser.
//!
//! Where the answer would need machinery this crate does not have — punycode and
//! the IDNA tables behind an `xn--` label — it REJECTS. A relay origin decides
//! which host a device trusts, so "no" is the only safe answer to "unknown".

/// Twin caps the origin at 2048 in BOTH UTF-16 units and UTF-8 bytes.
pub const RELAY_URL_MAX_CHARACTERS: usize = 2048;

pub fn is_canonical_https_origin(value: &str) -> bool {
    if orca_core::js_string::utf16_len(value) > RELAY_URL_MAX_CHARACTERS
        || value.len() > RELAY_URL_MAX_CHARACTERS
    {
        return false;
    }
    // The parser lowercases the scheme, so only the literal lowercase form can
    // ever equal its own origin.
    let Some(authority) = value.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match split_host_and_port(authority) {
        Some(parts) => parts,
        None => return false,
    };
    if let Some(port) = port {
        if !is_canonical_serialized_port(port) {
            return false;
        }
    }
    is_canonical_host(host)
}

/// Split `host[:port]`, keeping a bracketed IPv6 literal intact. `None` when the
/// bracket form is malformed (the parser would fail).
fn split_host_and_port(authority: &str) -> Option<(&str, Option<&str>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let close = rest.find(']')?;
        let host = &authority[..close + 2];
        return match &authority[close + 2..] {
            "" => Some((host, None)),
            tail => Some((host, Some(tail.strip_prefix(':')?))),
        };
    }
    match authority.split_once(':') {
        Some((host, port)) => Some((host, Some(port))),
        None => Some((authority, None)),
    }
}

/// A port survives into `origin` only in canonical decimal form, and 443 never
/// does (the https default is elided).
fn is_canonical_serialized_port(port: &str) -> bool {
    // `parse::<u32>` accepts a leading `+`; the URL parser does not, and `:+1`
    // throws there while reaching here as a well-formed port 1.
    if port.is_empty()
        || (port.len() > 1 && port.starts_with('0'))
        || !port.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    match port.parse::<u32>() {
        Ok(number) => number <= 65535 && number != 443,
        Err(_) => false,
    }
}

fn is_canonical_host(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        return parse_ipv6(inner).is_some_and(|pieces| serialize_ipv6(&pieces) == inner);
    }
    if !host.bytes().all(is_serialized_domain_byte) {
        return false;
    }
    if ends_in_a_number(host) {
        // The host is handed to the IPv4 parser, which either rewrites it or fails.
        return is_canonical_ipv4(host);
    }
    // Punycode + the IDNA validity tables are not modeled here; an `xn--` label is
    // refused rather than guessed at (see the module note).
    !host.split('.').any(|label| label.starts_with("xn--"))
}

/// Complement of the WHATWG "forbidden domain code point" set, minus anything the
/// serializer would rewrite: uppercase (IDNA lowercases) and non-ASCII (punycoded).
fn is_serialized_domain_byte(byte: u8) -> bool {
    match byte {
        b'a'..=b'z' | b'0'..=b'9' => true,
        b'!' | b'"' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' => true,
        b'-' | b'.' | b';' | b'=' | b'_' | b'`' | b'{' | b'}' | b'~' => true,
        _ => false,
    }
}

/// WHATWG "ends in a number": the trigger that sends a host to the IPv4 parser.
fn ends_in_a_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    let Some(last) = parts.last() else {
        return false;
    };
    if !last.is_empty() && last.bytes().all(|byte| byte.is_ascii_digit()) {
        return true;
    }
    parses_as_an_ipv4_number(last)
}

fn parses_as_an_ipv4_number(part: &str) -> bool {
    if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
        return hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if part.len() > 1 && part.starts_with('0') {
        return part[1..].bytes().all(|byte| (b'0'..=b'7').contains(&byte));
    }
    !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
}

/// The IPv4 serializer prints four shortest-form decimal octets, so only that
/// exact spelling survives the `value === origin` comparison.
fn is_canonical_ipv4(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() == 4
        && labels.iter().all(|label| {
            let digits_only = !label.is_empty() && label.bytes().all(|byte| byte.is_ascii_digit());
            let shortest = label.len() == 1 || !label.starts_with('0');
            digits_only && shortest && label.parse::<u32>().is_ok_and(|octet| octet <= 255)
        })
}

/// Hex-piece IPv6 only. The embedded-IPv4 form (`::ffff:1.2.3.4`) is deliberately
/// not parsed: the serializer rewrites it to hex pieces, so the twin rejects it
/// too, and both halves answer "not canonical".
fn parse_ipv6(text: &str) -> Option<[u16; 8]> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b':') {
        return None;
    }
    let (head, tail) = match text.split_once("::") {
        Some((head, tail)) => {
            if tail.contains("::") {
                return None;
            }
            (head, Some(tail))
        }
        None => (text, None),
    };
    let head_pieces = split_ipv6_pieces(head)?;
    let tail_pieces = match tail {
        Some(tail) => split_ipv6_pieces(tail)?,
        None => Vec::new(),
    };
    let total = head_pieces.len() + tail_pieces.len();
    if tail.is_none() && total != 8 {
        return None;
    }
    if tail.is_some() && total > 7 {
        return None;
    }
    let mut pieces = [0u16; 8];
    pieces[..head_pieces.len()].copy_from_slice(&head_pieces);
    let start = 8 - tail_pieces.len();
    pieces[start..].copy_from_slice(&tail_pieces);
    Some(pieces)
}

fn split_ipv6_pieces(segment: &str) -> Option<Vec<u16>> {
    if segment.is_empty() {
        return Some(Vec::new());
    }
    segment
        .split(':')
        .map(|piece| {
            (!piece.is_empty() && piece.len() <= 4)
                .then(|| u16::from_str_radix(piece, 16).ok())
                .flatten()
        })
        .collect()
}

/// WHATWG IPv6 serializer: lowercase hex, no leading zeros, the FIRST longest run
/// of two or more zero pieces compressed to `::`.
fn serialize_ipv6(pieces: &[u16; 8]) -> String {
    let mut best: Option<(usize, usize)> = None;
    let mut index = 0;
    while index < 8 {
        if pieces[index] != 0 {
            index += 1;
            continue;
        }
        let start = index;
        while index < 8 && pieces[index] == 0 {
            index += 1;
        }
        let length = index - start;
        if length > 1 && best.is_none_or(|(_, best_length)| length > best_length) {
            best = Some((start, length));
        }
    }
    let compress = best.map(|(start, _)| start);
    let mut out = String::new();
    let mut skipping_zeros = false;
    for (position, piece) in pieces.iter().enumerate() {
        if skipping_zeros {
            if *piece == 0 {
                continue;
            }
            skipping_zeros = false;
        }
        if compress == Some(position) {
            out.push_str(if position == 0 { "::" } else { ":" });
            skipping_zeros = true;
            continue;
        }
        out.push_str(&format!("{piece:x}"));
        if position != 7 {
            out.push(':');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_shapes_new_url_prints_as_its_own_origin() {
        for value in [
            "https://relay.onorca.dev",
            "https://relay-c1.onorca.dev",
            "https://x.dev:8443",
            "https://x.dev:0",
            "https://x.dev:65535",
            "https://x.dev.",
            "https://a..b",
            "https://.a",
            "https://.",
            "https://a-b_c~d.e",
            "https://1.2.3.4",
            "https://0.0.0.0",
            "https://255.255.255.255",
            "https://[::1]",
            "https://[::]",
            "https://[2001:db8::1]",
            "https://[1:2:3:4:5:6:7:8]",
            "https://[::1]:8443",
        ] {
            assert!(is_canonical_https_origin(value), "expected canonical: {value}");
        }
    }

    #[test]
    fn rejects_anything_the_serializer_would_rewrite() {
        for value in [
            "https://relay.onorca.dev/",
            "http://x.dev",
            "HTTPS://x.dev",
            "https://X.dev",
            "https://x.dev:443",
            "https://x.dev:",
            "https://x.dev:08443",
            "https://x.dev:65536",
            "https://x.dev:abc",
            "https://x.dev:+1",
            "https://x.dev:-1",
            "https://user@x.dev",
            "https://x.dev?a",
            "https://x.dev#f",
            "https://01.2.3.4",
            "https://1.2.3.4.",
            "https://1234567890",
            "https://0x7f.1",
            "https://foo.1",
            "https://foo.0x1",
            "https://a.08",
            "https://a.b.c.1",
            "https://1.1.1",
            "https://256.1.1.1",
            "https://[0:0:0:0:0:0:0:1]",
            "https://[0::1]",
            "https://[1::2:3:4:5:6:7]",
            "https://[2001:0db8::1]",
            "https://[::ffff:1.2.3.4]",
            "https://[::FFFF:0:0]",
            "https://[::1]:443",
            "https://[fe80::1%25eth0]",
            "https://x%41.dev",
            "https://x.dev ",
            " https://x.dev",
            "https://",
            "https://:443",
            "https:/x.dev",
            "ws://x.dev",
            "",
        ] {
            assert!(!is_canonical_https_origin(value), "expected non-canonical: {value}");
        }
    }

    #[test]
    fn refuses_internationalized_labels_rather_than_guessing_punycode() {
        // The twin accepts a VALID xn-- label and throws on an invalid one; neither
        // answer is derivable without the IDNA tables, so both are refused here.
        assert!(!is_canonical_https_origin("https://xn--80ak6aa92e.com"));
        assert!(!is_canonical_https_origin("https://xn--a.dev"));
    }

    #[test]
    fn caps_length_in_both_utf16_units_and_utf8_bytes() {
        let long_label = "a".repeat(RELAY_URL_MAX_CHARACTERS);
        assert!(!is_canonical_https_origin(&format!("https://{long_label}")));
        // Non-ASCII is rejected on its own, but the byte cap must trip first for a
        // value whose UTF-16 length is under the limit and whose byte length is not.
        let wide = "\u{10000}".repeat(600);
        assert!(!is_canonical_https_origin(&format!("https://{wide}")));
    }

    #[test]
    fn serializes_ipv6_like_the_whatwg_serializer() {
        assert_eq!(serialize_ipv6(&[0, 0, 0, 0, 0, 0, 0, 1]), "::1");
        assert_eq!(serialize_ipv6(&[0, 0, 0, 0, 0, 0, 0, 0]), "::");
        assert_eq!(serialize_ipv6(&[1, 2, 3, 4, 5, 6, 7, 8]), "1:2:3:4:5:6:7:8");
        assert_eq!(serialize_ipv6(&[0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]), "2001:db8::1");
        // Ties go to the FIRST longest run.
        assert_eq!(serialize_ipv6(&[1, 0, 0, 2, 0, 0, 3, 4]), "1::2:0:0:3:4");
    }
}
