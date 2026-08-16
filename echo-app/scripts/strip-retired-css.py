import re
import sys

CSS_PATH = r"D:/AI文件/echozcode/echo-app/src/index.css"

RETIRED = {
    "yinyi-page", "yinyi-scroll", "book", "paper-page", "page-head",
    "date-stamp", "date-weather", "entry", "entry-body", "entry-foot",
    "sign", "today-played", "t", "page-hot", "page-arrow",
    "writing-ink", "writing-copy", "writing-paper", "writing-line",
    "writing-title", "writing-subtitle", "writing-cancel", "yinyi-writing",
    "tb-pulse-dot", "yinyi-generate-btn", "date-picker",
}

RETIRED_KEYFRAMES: set[str] = set()

token_re = re.compile(r"[.#]?-?[A-Za-z0-9_-]+")


def selector_is_retired(sel: str) -> bool:
    sel = sel.strip()
    if not sel:
        return False
    # pseudo/keyframes names
    for token in token_re.findall(sel):
        name = token.lstrip(".#")
        if name in RETIRED:
            return True
    return False


def main() -> None:
    css = open(CSS_PATH, encoding="utf-8").read()
    out_lines: list[str] = []
    i = 0
    n = len(css)
    removed_rules = 0

    while i < n:
        ch = css[i]
        if ch in " \t\r\n":
            out_lines.append(ch)
            i += 1
            continue
        if ch == "/" and css[i:i+2] == "/*":
            end = css.find("*/", i)
            end = n if end == -1 else end + 2
            out_lines.append(css[i:end])
            i = end
            continue
        # find selector up to '{' or ';' or '}' or next rule
        j = i
        depth = 0
        while j < n and css[j] not in "{;}":
            j += 1
        header = css[i:j].strip()
        if j >= n or css[j] == ";":
            # stray statement (e.g. @import) — keep
            out_lines.append(css[i:j+1] if j < n else css[i:j])
            i = j + 1
            continue
        # css[j] == '{' — find matching '}'
        k = j + 1
        depth = 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        body = css[j+1:k-1]

        if header.startswith("@keyframes"):
            name = header.split()[1] if len(header.split()) > 1 else ""
            if name in RETIRED_KEYFRAMES:
                removed_rules += 1
            else:
                out_lines.append(css[i:k])
        elif header.startswith("@media") or header.startswith("@supports"):
            # recurse into body
            sub = process_body(body)
            if sub.strip():
                out_lines.append(header + "{" + sub + "}")
            else:
                removed_rules += 1
        elif header.startswith("@"):
            out_lines.append(css[i:k])
        else:
            parts = [p for p in header.split(",")]
            kept = [p for p in parts if not selector_is_retired(p)]
            if kept:
                if len(kept) != len(parts):
                    out_lines.append(", ".join(kept) + " {" + body + "}")
                else:
                    out_lines.append(css[i:k])
            else:
                removed_rules += 1
        i = k

    result = "".join(out_lines)
    result = re.sub(r"\n{3,}", "\n\n", result)
    open(CSS_PATH, "w", encoding="utf-8", newline="\n").write(result)
    print(f"removed {removed_rules} rules")


def process_body(body: str) -> str:
    """Process nested rules inside @media blocks."""
    out: list[str] = []
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch in " \t\r\n":
            out.append(ch)
            i += 1
            continue
        if ch == "/" and body[i:i+2] == "/*":
            end = body.find("*/", i)
            end = n if end == -1 else end + 2
            out.append(body[i:end])
            i = end
            continue
        j = i
        while j < n and body[j] not in "{;}":
            j += 1
        header = body[i:j].strip()
        if j >= n or body[j] == ";":
            out.append(body[i:j+1] if j < n else body[i:j])
            i = j + 1
            continue
        k = j + 1
        depth = 1
        while k < n and depth:
            if body[k] == "{":
                depth += 1
            elif body[k] == "}":
                depth -= 1
            k += 1
        parts = header.split(",")
        kept = [p for p in parts if not selector_is_retired(p)]
        if kept:
            out.append(", ".join(kept) + " {" + body[j+1:k-1] + "}")
        i = k
    return "".join(out)


if __name__ == "__main__":
    main()
