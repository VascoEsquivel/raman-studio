"""Parse the data constants out of the Raman graphene atlas (index.html).

The atlas keeps its band data as JavaScript object literals (REFS, PEAKS,
RATIOS, CHEAT) inside a <script> tag. This module reads those literals with a
tiny JS-literal parser so the values are copied exactly — no hand transcription.

Supported literal syntax (everything the atlas uses): objects with identifier
or quoted keys, arrays, single/double-quoted strings with escapes, numbers
(including a leading '.', e.g. `.13`), true/false/null, trailing commas.
"""
from __future__ import annotations

import re

CONSTANTS = ("REFS", "PEAKS", "RATIOS", "CHEAT")


class JSLiteralParser:
    def __init__(self, src: str, pos: int = 0):
        self.s = src
        self.i = pos

    # -- low level -----------------------------------------------------
    def ws(self):
        s, n = self.s, len(self.s)
        while self.i < n:
            c = s[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = n if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                if j < 0:
                    raise ValueError("unterminated comment")
                self.i = j + 2
            else:
                break

    def peek(self) -> str:
        self.ws()
        return self.s[self.i] if self.i < len(self.s) else ""

    def expect(self, ch: str):
        if self.peek() != ch:
            raise ValueError(f"expected {ch!r} at {self.i}: {self.s[self.i:self.i+40]!r}")
        self.i += 1

    # -- values --------------------------------------------------------
    def value(self):
        c = self.peek()
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c in "\"'":
            return self.string()
        if c in "-+.0123456789":
            return self.number()
        for word, val in (("true", True), ("false", False), ("null", None)):
            if self.s.startswith(word, self.i):
                self.i += len(word)
                return val
        raise ValueError(f"unexpected token at {self.i}: {self.s[self.i:self.i+40]!r}")

    def string(self) -> str:
        q = self.s[self.i]
        self.i += 1
        out = []
        while True:
            c = self.s[self.i]
            if c == q:
                self.i += 1
                return "".join(out)
            if c == "\\":
                nxt = self.s[self.i + 1]
                esc = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
                if nxt in esc:
                    out.append(esc[nxt]); self.i += 2
                elif nxt == "u":
                    out.append(chr(int(self.s[self.i + 2:self.i + 6], 16))); self.i += 6
                elif nxt == "x":
                    out.append(chr(int(self.s[self.i + 2:self.i + 4], 16))); self.i += 4
                else:
                    out.append(nxt); self.i += 2
                continue
            if c == "\n":
                raise ValueError(f"newline in string at {self.i}")
            out.append(c)
            self.i += 1

    def number(self):
        m = re.compile(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?").match(self.s, self.i)
        if not m:
            raise ValueError(f"bad number at {self.i}")
        self.i = m.end()
        txt = m.group(0)
        return float(txt) if any(ch in txt for ch in ".eE") else int(txt)

    def key(self) -> str:
        c = self.peek()
        if c in "\"'":
            return self.string()
        m = re.compile(r"[A-Za-z_$][\w$]*").match(self.s, self.i)
        if not m:
            raise ValueError(f"bad key at {self.i}: {self.s[self.i:self.i+30]!r}")
        self.i = m.end()
        return m.group(0)

    def obj(self) -> dict:
        self.expect("{")
        out = {}
        while self.peek() != "}":
            k = self.key()
            self.expect(":")
            out[k] = self.value()
            if self.peek() == ",":
                self.i += 1
        self.expect("}")
        return out

    def arr(self) -> list:
        self.expect("[")
        out = []
        while self.peek() != "]":
            out.append(self.value())
            if self.peek() == ",":
                self.i += 1
        self.expect("]")
        return out


def parse_constants(html: str) -> dict:
    """Return {name: parsed literal} for every atlas data constant."""
    out = {}
    for name in CONSTANTS:
        m = re.search(r"\bconst\s+" + name + r"\s*=\s*", html)
        if not m:
            raise ValueError(f"constant {name} not found in atlas source")
        out[name] = JSLiteralParser(html, m.end()).value()
    return out


def inner_html(html: str, selector_regex: str) -> str:
    """innerHTML of the first element whose opening tag matches selector_regex.
    Only used for flat elements (no nested tags of the same name)."""
    m = re.search(r"<(\w+)[^>]*" + selector_regex + r"[^>]*>", html)
    if not m:
        raise ValueError(f"element {selector_regex!r} not found")
    tag = m.group(1)
    start = m.end()
    end = html.index(f"</{tag}>", start)
    return html[start:end]


def parse_notes(html: str) -> dict:
    """Free-text notes from the atlas page, verbatim (HTML fragments)."""
    title = re.search(r"<h1>(.*?)</h1>", html, re.S).group(1)
    return {
        "title": title,
        "subtitle": inner_html(html, r'class="sub"').strip(),
        "banner": inner_html(html, r'class="note-banner"').strip(),
        "referencesNote": inner_html(html, r'class="refnote"').strip(),
        "footer": inner_html(html, r'class="foot"').strip(),
    }
