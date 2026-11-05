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

// Keep only a validated duration; free-form ban reasons must never escape this layer.
pub(crate) fn ban_seconds(message: &str, extra: Option<&str>) -> Option<u64> {
    fn duration(text: &str, bare: bool) -> Option<u64> {
        let text = text.trim().to_ascii_lowercase();
        if let Some(seconds) = text.parse::<u64>().ok().filter(|_| bare) {
            return Some(seconds);
        }
        let tail = [
            "you may retry in ",
            "retry in ",
            "retry after ",
            "ban expires in ",
            "ban time remaining: ",
            "time=",
            "bantime=",
            "duration=",
        ]
        .iter()
        .find_map(|prefix| text.split_once(prefix).map(|(_, tail)| tail));
        let value = tail.or_else(|| bare.then_some(text.as_str()))?;
        let digits = value.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let number = value[..digits].parse::<u64>().ok()?;
        let suffix = value[digits..].trim().trim_end_matches(['.', '!']);
        match suffix {
            "seconds" | "second" | "secs" | "sec" | "s" => Some(number),
            "minutes" | "minute" | "mins" | "min" => number.checked_mul(60),
            "" if bare
                || tail.is_some_and(|_| text.contains("time=") || text.contains("duration=")) =>
            {
                Some(number)
            }
            _ => None,
        }
    }
    extra
        .and_then(|text| duration(text, true))
        .or_else(|| duration(message, false))
}
#[cfg(test)]
mod ban_tests {
    use super::*;
    #[test]
    fn extracts_only_explicit_remaining_durations() {
        assert_eq!(ban_seconds("you may retry in 125 seconds", None), Some(125));
        assert_eq!(
            ban_seconds("banned, retry after 2 minutes.", None),
            Some(120)
        );
        assert_eq!(ban_seconds("banned", Some("time=65")), Some(65));
        assert_eq!(ban_seconds("banned", Some("42")), Some(42));
        assert_eq!(
            ban_seconds("banned", Some("you may retry in 3 seconds")),
            Some(3)
        );
        assert_eq!(ban_seconds("banned", Some("0")), Some(0));
        for message in [
            "flood prevention, please try again later",
            "permanent ban",
            "user 123 banned",
            "retry in many seconds",
            "retry in 18446744073709551615 minutes",
        ] {
            assert_eq!(ban_seconds(message, None), None);
        }
    }
}
