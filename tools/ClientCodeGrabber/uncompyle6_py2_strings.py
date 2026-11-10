"""Run uncompyle6 with two fixes for Python 2 bytecode.

1. xdis 6.1.x renders Python 2 unicode constants with UnicodeForPython3.__repr__, which does
   not escape quotes, backslashes or newlines, and for non-ASCII text drops the first two
   characters and writes a bogus \\u prefix. The decompiled source then either fails to compile
   or carries a wrong string. The replacement repr writes an escaped ASCII form that Python 2
   reads back to the same value.
2. uncompyle6 3.9.x folds runs of five or more constants into one list or set token. For
   Python 2 bytecode those tokens carry the constant's index in `attr` and its value in
   `pattr`, but the list and set printer writes `attr`, so `['OnA', 'OnB', ...]` comes out as
   `[2, 3, ...]`. The patch moves the value into `attr`.
3. xdis decodes a Python 2 byte string as UTF-8 text when it can, so a constant such as
   '\\xef\\xbb\\xbf' is printed as '\\ufeff', which Python 2 reads as six literal characters.
   The patch keeps such strings as text but prints the original bytes as \\x escapes.
4. In a module with `from __future__ import unicode_literals`, uncompyle6 writes every str
   constant with a b prefix. UnicodeForPython3 is a str subclass, so unicode constants get it
   too and come out as bu'...', which does not compile. The patch writes those without the b.
5. `from .x import *` loses its dots: the star-import printer counts them from the level
   constant's table index instead of its value, so a relative star import becomes an implicit
   relative one (`from x import *`). The patch counts them from the value, as uncompyle6 already
   does for other `from` imports in Python 2.6 and 2.7.

Then it runs the normal uncompyle6 command line.

Run with a Python that can import uncompyle6, with uncompyle6's usual arguments:
  python uncompyle6_py2_strings.py -o <out dir> <file.pyc>
"""
import sys

from xdis.cross_types import UnicodeForPython3


def _py2_unicode_repr(self):
    # Python 2 marshals unicode as UTF-8; lone surrogates are allowed there.
    text = self.value.decode("utf-8", "surrogatepass")
    # ascii() escapes quotes, backslashes, control and non-ASCII characters with \x, \u and \U,
    # which a Python 2 u'' literal reads back to the same value.
    return "u" + ascii(text)


UnicodeForPython3.__repr__ = _py2_unicode_repr

import xdis.unmarshal  # noqa: E402

_compat_str = xdis.unmarshal.compat_str


class Py2ByteString(str):
    """A Python 2 str constant that is not plain ASCII; repr() writes its original bytes."""

    def __new__(cls, text, raw):
        self = super().__new__(cls, text)
        self.raw = raw
        return self

    def __repr__(self):
        return repr(self.raw)[1:]  # drop the b of b'...'; escapes match Python 2 str literals


def _compat_str_keeping_bytes(s):
    value = _compat_str(s)
    if isinstance(s, bytes) and isinstance(value, str) and not s.isascii():
        return Py2ByteString(value, s)
    return value


# Only Python 2 bytecode reaches compat_str with non-ASCII bytes in this tool's use.
xdis.unmarshal.compat_str = _compat_str_keeping_bytes

from uncompyle6.scanner import Scanner  # noqa: E402

_bound_collection_from_tokens = Scanner.bound_collection_from_tokens


def _bound_collection_with_values(self, tokens, t, i, collection_type):
    new_tokens = _bound_collection_from_tokens(self, tokens, t, i, collection_type)
    if new_tokens is not None:
        for token in new_tokens[-(t.attr + 2):]:
            if token.kind == "ADD_VALUE":
                token.attr = token.pattr
    return new_tokens


# Only the Python 2 scanners use the base-class version; the Python 3.7+ scanner has its own.
Scanner.bound_collection_from_tokens = _bound_collection_with_values

from uncompyle6.semantics.n_actions import NonterminalActions  # noqa: E402

_n_LOAD_CONST = NonterminalActions.n_LOAD_CONST


def _n_LOAD_CONST_unicode_literals(self, node):
    if self.FUTURE_UNICODE_LITERALS and isinstance(node.pattr, UnicodeForPython3):
        self.write(repr(node.pattr))
        self.prune()
    return _n_LOAD_CONST(self, node)


NonterminalActions.n_LOAD_CONST = _n_LOAD_CONST_unicode_literals

_n_import_from_star = NonterminalActions.n_import_from_star


def _n_import_from_star_py2(self, node):
    if (2, 5) <= self.version < (3, 0):
        level = node[0].pattr
        if isinstance(level, int) and level > 0 and not node[2].pattr.startswith("."):
            node[2].pattr = "." * level + node[2].pattr
        self.default(node)
        return
    return _n_import_from_star(self, node)


NonterminalActions.n_import_from_star = _n_import_from_star_py2

from uncompyle6.bin.uncompile import main_bin  # noqa: E402

if __name__ == "__main__":
    sys.exit(main_bin())
