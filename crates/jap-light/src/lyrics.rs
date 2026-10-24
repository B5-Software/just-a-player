#[derive(Clone, Debug, Default)]
pub struct Line {
    pub at: u64,
    pub text: String,
    pub words: Vec<(u64, String)>,
}
fn stamp(s: &str) -> Option<u64> {
    let (m, s) = s.split_once(':')?;
    let ms = (m.parse::<f64>().ok()? * 60. + s.parse::<f64>().ok()?) * 1000.;
    (ms.is_finite() && ms >= 0.).then_some(ms.round() as u64)
}
pub fn parse(text: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let mut offset = 0i64;
    for raw in text.lines() {
        if let Some(s) = raw
            .trim()
            .strip_prefix("[offset:")
            .and_then(|s| s.strip_suffix(']'))
        {
            offset = s.parse::<i64>().unwrap_or(0).clamp(-86_400_000, 86_400_000);
        }
    }
    for raw in text.lines() {
        let mut marks = Vec::new();
        let mut rest = raw.trim();
        while let Some(s) = rest.strip_prefix('[') {
            let Some((tag, tail)) = s.split_once(']') else {
                break;
            };
            let Some(t) = stamp(tag) else { break };
            marks.push(t);
            rest = tail;
        }
        if marks.is_empty() {
            continue;
        }
        if rest.contains('[') || rest.contains('<') {
            // Enhanced LRC: the first timestamp is also the first word's time.
            let mut line = Line {
                at: marks[0],
                ..Default::default()
            };
            let mut at = marks[0];
            let mut s = rest;
            loop {
                let end = s.find(['[', '<']).unwrap_or(s.len());
                let word = &s[..end];
                if !word.is_empty() {
                    line.text.push_str(word);
                    line.words.push((at, word.into()));
                }
                if end == s.len() {
                    break;
                }
                let tag = &s[end + 1..];
                let Some(close) = tag.find([']', '>']) else {
                    break;
                };
                if let Some(t) = stamp(&tag[..close]) {
                    at = t;
                }
                s = &tag[close + 1..];
            }
            out.push(line);
        } else {
            for at in marks {
                out.push(Line {
                    at,
                    text: rest.into(),
                    words: Vec::new(),
                });
            }
        }
    }
    for line in &mut out {
        line.at = line.at.saturating_add_signed(-offset);
        for (at, _) in &mut line.words {
            *at = at.saturating_add_signed(-offset);
        }
    }
    out.sort_by_key(|line| line.at);
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enhanced_words_offsets_and_repeated_lines() {
        let l = parse("[offset:-6]\n[00:01.000]音[00:01.500]乐[00:02.000]\n[00:03][00:05]重复");
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].at, 1006);
        assert_eq!(l[0].text, "音乐");
        assert_eq!(l[0].words[1].0, 1506);
        assert_eq!(l[2].at, 5006);
    }
}
