// Mluvka patch: a safe marker, never a retained/logged server message.
pub(crate) fn is_handshake_flood(code: u32, extra: Option<&str>) -> bool {
    code == 0x0d01
        && extra.is_some_and(|text| {
            text.eq_ignore_ascii_case("flood prevention, please try again later")
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_handshake_marker_is_transient_but_real_bans_are_not() {
        assert!(is_handshake_flood(
            0x0d01,
            Some("flood prevention, please try again later")
        ));
        for reason in [
            None,
            Some("permanent ban"),
            Some("flood"),
            Some("ban.example.org"),
        ] {
            assert!(!is_handshake_flood(0x0d01, reason));
        }
        assert!(!is_handshake_flood(
            0x0209,
            Some("flood prevention, please try again later")
        ));
    }
}
