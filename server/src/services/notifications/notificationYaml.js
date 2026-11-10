"use strict";

// A notification's data as the YAML text Tranquility's notification rows carry.
//
// Tranquility answers notificationMgr's reads with a CRowset whose rows' `data` column is the notification's data
// as YAML text (DBTYPE_WSTR), which the client loads where it is text (notificationSvc.py TryUnYamlNotificationData,
// 148 to 156; notificationUtil.Format, 1506 to 1510: yaml.load with CSafeLoader). The recordings
// (D:\SSDSync\EveBadStuff\LOGS\Archive: "Logging In To Space.txt", "Resign As CEO - Corp Disbands.txt") have it as
// PyYAML's safe_dump writes it in block style, keys sorted:
//
//   amount: 4899887.0\ncorpID: 98838096\npayout: 4899887.0\n
//   ownerCorpLinkData:\n- showinfo\n- 2\n- 98827279\nownerCorpName: Deep Sky Accord Holdings\n...
//   applicationText: It's me, Flannel\ncharID: 2124510715\ncorpID: 98827279\n
//
// This writes it as the client's own PyYAML does (its yaml/emitter.py and representer.py, run in the client's
// python27.dll to compare): a mapping's keys sorted, a nested mapping indented by two, a sequence in a mapping not
// indented, an empty collection in flow ({} and []), each string in the style choose_scalar_style picks
// (analyze_scalar: plain where the YAML 1.1 resolvers would read it back as a string and nothing in it forbids,
// else single-quoted, else double-quoted with escapes, non-ASCII escaped as allow_unicode is off), a long one folded
// past 80 columns as write_plain, write_single_quoted and write_double_quoted fold it, and a float as Python's
// repr with ".0" where it has no point. Python 2's unicode on Windows counts UTF-16 units, as these loops do. What
// it does not do of PyYAML's: an anchor for an object met twice (Tranquility's "structureID: &id001 1054668720660"
// and "- *id001"), which the client loads to the same value; and a character past the BMP is one \U escape, not
// the two \u escapes of its halves the client's loader refuses.

const BEST_WIDTH = 80;
const BEST_INDENT = 2;

// The YAML 1.1 implicit resolvers of PyYAML's SafeLoader (resolver.py): a string a plain scalar of which would read
// back as another type is quoted (its implicit[0] is false).
const RESOLVES_TO_OTHER = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:~|null|Null|NULL|)$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)?)$/,
  /^<<$/,
  /^=$/,
];

const LINE_BREAKS = "\n\x85\u2028\u2029";
const WHITESPACE = "\0 \t\r\n\x85\u2028\u2029";

/** emitter.analyze_scalar: what the scalar allows, from its characters (UTF-16 units, as a narrow build's). */
function analyzeScalar(scalar) {
  if (scalar === "") return { empty: true, multiline: false, blockPlain: true, singleQuoted: true };
  let blockIndicators = false;
  let lineBreaks = false;
  let special = false;
  let leadingSpace = false;
  let leadingBreak = false;
  let trailingSpace = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  if (scalar.startsWith("---") || scalar.startsWith("...")) blockIndicators = true;
  let precededByWhitespace = true;
  let followedByWhitespace = scalar.length === 1 || WHITESPACE.includes(scalar[1]);
  let previousSpace = false;
  let previousBreak = false;
  for (let index = 0; index < scalar.length; index += 1) {
    const ch = scalar[index];
    if (index === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) blockIndicators = true;
      if ("?:".includes(ch) && followedByWhitespace) blockIndicators = true;
      if (ch === "-" && followedByWhitespace) blockIndicators = true;
    } else {
      if (ch === ":" && followedByWhitespace) blockIndicators = true;
      if (ch === "#" && precededByWhitespace) blockIndicators = true;
    }
    if (LINE_BREAKS.includes(ch)) lineBreaks = true;
    if (!(ch === "\n" || (ch >= "\x20" && ch <= "\x7e"))) special = true;
    if (ch === " ") {
      if (index === 0) leadingSpace = true;
      if (index === scalar.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if (LINE_BREAKS.includes(ch)) {
      if (index === 0) leadingBreak = true;
      if (index === scalar.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWhitespace = WHITESPACE.includes(ch);
    followedByWhitespace = index + 2 >= scalar.length || WHITESPACE.includes(scalar[index + 2]);
  }
  let blockPlain = true;
  let singleQuoted = true;
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) blockPlain = false;
  if (breakSpace) blockPlain = singleQuoted = false;
  if (spaceBreak || special) blockPlain = singleQuoted = false;
  if (lineBreaks) blockPlain = false;
  if (blockIndicators) blockPlain = false;
  return { empty: false, multiline: lineBreaks, blockPlain, singleQuoted };
}

/** emitter.choose_scalar_style, for a string (implicit where no resolver reads its plain form as another type). */
function scalarStyle(text, simpleKey) {
  const analysis = analyzeScalar(text);
  const implicit = !RESOLVES_TO_OTHER.some((pattern) => pattern.test(text));
  if (implicit && !(simpleKey && (analysis.empty || analysis.multiline)) && analysis.blockPlain) return "";
  if (analysis.singleQuoted && !(simpleKey && analysis.multiline)) return "'";
  return '"';
}

const ESCAPE_REPLACEMENTS = { "\0": "0", "\x07": "a", "\x08": "b", "\t": "t", "\n": "n", "\x0b": "v", "\x0c": "f", "\r": "r", "\x1b": "e", '"': '"', "\\": "\\", "\x85": "N", "\xa0": "_", "\u2028": "L", "\u2029": "P" };

/**
 * A scalar written as the emitter writes it, from `column` (where the line stands before it) with `indent` for a line
 * it folds onto: write_plain, write_single_quoted or write_double_quoted. Answers the text from the space that
 * separates it on: " value", or " 'value'" and its continuation lines.
 */
function writeScalar(text, style, column, indent, split) {
  let out = "";
  let col = column;
  const write = (data) => {
    out += data;
    col += data.length;
  };
  const writeIndent = () => {
    // write_indent inside a scalar (indention off): a line break, then the indent.
    out += `\n${" ".repeat(indent)}`;
    col = indent;
  };
  const lineBreak = () => {
    out += "\n";
    col = 0;
  };
  if (style === "") {
    write(" ");
    let spaces = false;
    let start = 0;
    for (let end = 0; end <= text.length; end += 1) {
      const ch = end < text.length ? text[end] : null;
      if (spaces) {
        if (ch !== " ") {
          if (start + 1 === end && col > BEST_WIDTH && split) writeIndent();
          else write(text.slice(start, end));
          start = end;
        }
      } else if (ch === null || (" " + LINE_BREAKS).includes(ch)) {
        write(text.slice(start, end));
        start = end;
      }
      if (ch !== null) spaces = ch === " ";
    }
    return out;
  }
  if (style === "'") {
    write(" '");
    let spaces = false;
    let breaks = false;
    let start = 0;
    for (let end = 0; end <= text.length; end += 1) {
      const ch = end < text.length ? text[end] : null;
      if (spaces) {
        if (ch === null || ch !== " ") {
          if (start + 1 === end && col > BEST_WIDTH && split && start !== 0 && end !== text.length) writeIndent();
          else write(text.slice(start, end));
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !LINE_BREAKS.includes(ch)) {
          if (text[start] === "\n") lineBreak();
          for (const br of text.slice(start, end)) {
            out += br;
            col = 0;
          }
          writeIndentAfterBreaks();
          start = end;
        }
      } else if (ch === null || (" " + LINE_BREAKS).includes(ch) || ch === "'") {
        if (start < end) {
          write(text.slice(start, end));
          start = end;
        }
      }
      if (ch === "'") {
        write("''");
        start = end + 1;
      }
      if (ch !== null) {
        spaces = ch === " ";
        breaks = LINE_BREAKS.includes(ch);
      }
    }
    write("'");
    return out;
  }
  write(' "');
  let start = 0;
  for (let end = 0; end <= text.length; end += 1) {
    const ch = end < text.length ? text[end] : null;
    if (ch === null || '"\\\x85\u2028\u2029\ufeff'.includes(ch) || !(ch >= "\x20" && ch <= "\x7e")) {
      if (start < end) {
        write(text.slice(start, end));
        start = end;
      }
      if (ch !== null) {
        const code = ch.charCodeAt(0);
        const low = end + 1 < text.length ? text.charCodeAt(end + 1) : 0;
        // A character past the BMP: PyYAML on a narrow build escapes its two halves (😀), which the
        // client's own CSafeLoader refuses (a ScannerError, run in its python27.dll); one \U escape loads.
        const pair = code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
        const data = pair
          ? `\\U${((code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000).toString(16).toUpperCase().padStart(8, "0")}`
          : Object.prototype.hasOwnProperty.call(ESCAPE_REPLACEMENTS, ch)
            ? `\\${ESCAPE_REPLACEMENTS[ch]}`
            : code <= 0xff
              ? `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`
              : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
        write(data);
        start = end + 1;
        if (pair) {
          end += 1;
          start = end + 1;
        }
      }
    }
    if (end > 0 && end < text.length - 1 && (ch === " " || start >= end) && col + (end - start) > BEST_WIDTH && split) {
      const data = `${text.slice(start, end)}\\`;
      if (start < end) start = end;
      write(data);
      writeIndent();
      if (text[start] === " ") write("\\");
    }
  }
  write('"');
  return out;

  // After a run of line breaks in a single-quoted scalar the line is at its start: the indent alone.
  function writeIndentAfterBreaks() {
    if (col < indent) {
      out += " ".repeat(indent - col);
      col = indent;
    }
  }
}

/** A string as a mapping's simple key (no folding), from `column`, without the separating space. */
function keyText(key, column) {
  return writeScalar(key, scalarStyle(key, true), column, 0, false).slice(1);
}

/** A float as Python's repr writes it, as PyYAML's represent_float does (".0" put in where repr has no point). */
function floatScalar(number) {
  if (Number.isNaN(number)) return ".nan";
  if (number === Infinity) return ".inf";
  if (number === -Infinity) return "-.inf";
  const magnitude = Math.abs(number);
  let text;
  if (magnitude !== 0 && (magnitude >= 1e16 || magnitude < 1e-4)) {
    const [mantissa, exponent] = number.toExponential().split("e");
    const sign = exponent.startsWith("-") ? "-" : "+";
    text = `${mantissa}e${sign}${exponent.replace(/^[-+]/, "").padStart(2, "0")}`;
  } else {
    text = String(number);
    if (!text.includes(".")) text += ".0";
  }
  if (!text.includes(".") && text.includes("e")) text = text.replace("e", ".0e");
  return text;
}

/** An integer kept as its digits (a long past what a number holds exactly), and a float that is a float. */
class Integer {
  constructor(digits) {
    this.digits = digits;
  }
}
class Real {
  constructor(number) {
    this.number = number;
  }
}

/**
 * The data as plain values: a number, a string, a boolean, null, an array or an object; a marshal form EveJS keeps
 * in a notification's data read as what it stands for ({type: "long"} an integer kept as its digits, "real" a float,
 * "list" and "tuple" a sequence, "dict" a mapping, "wstring" and "token" a string). Anything else is null.
 */
function plainOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return new Integer(value.toString());
  if (Array.isArray(value)) return value.map(plainOf);
  if (typeof value === "object") {
    switch (value.type) {
      case "long":
      case "int":
        return /^-?\d+$/.test(String(value.value)) ? new Integer(String(value.value)) : null;
      case "real":
        return new Real(Number(value.value));
      case "list":
      case "tuple":
        return (Array.isArray(value.items) ? value.items : []).map(plainOf);
      case "dict":
        return Object.fromEntries((Array.isArray(value.entries) ? value.entries : []).map(([key, entry]) => [String(plainKey(key)), plainOf(entry)]));
      case "wstring":
      case "token":
        return String(value.value ?? "");
      case undefined:
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainOf(entry)]));
      default:
        return null;
    }
  }
  return null;
}

function plainKey(key) {
  if (key && typeof key === "object" && "value" in key) return key.value;
  return key;
}

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Integer) && !(value instanceof Real);
const isEmptyCollection = (value) => (Array.isArray(value) && value.length === 0) || (isMapping(value) && Object.keys(value).length === 0);
const emptyText = (value) => (Array.isArray(value) ? "[]" : "{}");

/** A scalar after its line's start (`prefix`), as " value": a string as the emitter writes it, anything else as represented. */
function scalarAfter(value, prefix, indent) {
  if (typeof value === "string") return writeScalar(value, scalarStyle(value, false), prefix.length, indent, true);
  if (value === null) return " null";
  if (typeof value === "boolean") return value ? " true" : " false";
  if (typeof value === "number") return ` ${Number.isInteger(value) ? String(value) : floatScalar(value)}`;
  if (value instanceof Integer) return ` ${value.digits}`;
  if (value instanceof Real) return ` ${floatScalar(value.number)}`;
  return " null";
}

/**
 * A node's lines, the first begun with `head` (a sequence's "- ", or nothing): a mapping at `indent`
 * (expect_block_mapping), a sequence at `indent` (in a mapping indentless), each scalar at its container's indent
 * and two (expect_scalar's increase_indent).
 */
function mappingLines(mapping, indent, head = null) {
  const lines = [];
  const keys = Object.keys(mapping).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  keys.forEach((key, place) => {
    const start = place === 0 && head !== null ? head : " ".repeat(indent);
    const prefix = `${start}${keyText(key, start.length)}:`;
    const value = mapping[key];
    if (isEmptyCollection(value)) lines.push(`${prefix} ${emptyText(value)}`);
    else if (Array.isArray(value)) lines.push(prefix, ...sequenceLines(value, indent));
    else if (isMapping(value)) lines.push(prefix, ...mappingLines(value, indent + BEST_INDENT));
    else lines.push(...`${prefix}${scalarAfter(value, prefix, indent + BEST_INDENT)}`.split("\n"));
  });
  return lines;
}

function sequenceLines(sequence, indent, head = null) {
  const lines = [];
  sequence.forEach((item, place) => {
    const start = `${place === 0 && head !== null ? head : " ".repeat(indent)}-`;
    if (isEmptyCollection(item)) lines.push(`${start} ${emptyText(item)}`);
    else if (Array.isArray(item)) lines.push(...sequenceLines(item, indent + BEST_INDENT, `${start} `));
    else if (isMapping(item)) lines.push(...mappingLines(item, indent + BEST_INDENT, `${start} `));
    else lines.push(...`${start}${scalarAfter(item, start, indent + BEST_INDENT)}`.split("\n"));
  });
  return lines;
}

/** A notification's data as YAML text, as Tranquility's rows carry it (yaml.safe_dump, block style). */
function notificationDataYaml(data) {
  const plain = plainOf(data);
  if (isEmptyCollection(plain)) return `${emptyText(plain)}\n`;
  if (Array.isArray(plain)) return `${sequenceLines(plain, 0).join("\n")}\n`;
  if (isMapping(plain)) return `${mappingLines(plain, 0).join("\n")}\n`;
  return `${scalarAfter(plain, "", BEST_INDENT).slice(1)}\n...\n`;
}

module.exports = {
  notificationDataYaml,
};
