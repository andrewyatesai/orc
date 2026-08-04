//! Node's `Buffer.toString('base64url')` / `Buffer.from(text, 'base64url')`:
//! the URL-safe alphabet, never padded. Hand-rolled because the workspace is
//! offline/vendored and no base64 crate is available — one copy, shared by the
//! `listRuns` cursor codec and every `dcap_` capability mint.

const ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Node `Buffer.toString('base64url')`.
pub fn encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let packed = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        encoded.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        encoded.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            encoded.push(ALPHABET[(packed >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            encoded.push(ALPHABET[packed as usize & 63] as char);
        }
    }
    encoded
}

/// Node `Buffer.from(text, 'base64url')` — both alphabets and optional padding
/// are accepted, as Node's decoder does; `None` only for a non-base64 byte.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    let mut decoded = Vec::with_capacity(text.len() * 3 / 4);
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let value = u32::from(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        });
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push((accumulator >> bits) as u8);
        }
    }
    Some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_node_buffer_encoding() {
        // RFC 4648 vectors, unpadded.
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg");
        assert_eq!(encode(b"fo"), "Zm8");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg");
        assert_eq!(encode(b"fooba"), "Zm9vYmE");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
        // The URL alphabet: `-`/`_` in place of `+`/`/`, and never padded.
        assert_eq!(encode(&[0xfb, 0xff, 0xbf]), "-_-_");
        assert_eq!(encode(&[0xfb, 0xff, 0xfe]), "-__-");
        assert_eq!(encode(&[0u8; 32]).len(), 43);
    }

    #[test]
    fn decode_round_trips_and_accepts_the_node_leniency() {
        for payload in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0xfb, 0xff, 0xfe][..]] {
            let encoded = encode(payload);
            assert!(!encoded.contains('='));
            assert!(!encoded.contains('+') && !encoded.contains('/'));
            assert_eq!(decode(&encoded).unwrap(), payload);
        }
        // Padded and standard-alphabet input still decodes, as Node's does.
        assert_eq!(decode("YQ==").unwrap(), b"a");
        assert_eq!(decode("+/8").unwrap(), decode("-_8").unwrap());
        assert!(decode("no!").is_none());
    }
}
