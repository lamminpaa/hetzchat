import { describe, expect, it } from "vitest";
import { MarkdownStream } from "../../src/cli/markdown.js";

const ESC = "\u001b";
const ANSI_PATTERN = /\u001b\[\d+m/g;
const RESET = `${ESC}[0m`;

const stripAnsi = (text: string): string => text.replaceAll(ANSI_PATTERN, "");

function render(text: string, chunkSize: number, color = true): string {
  const stream = new MarkdownStream(color);
  let out = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    out += stream.push(text.slice(i, i + chunkSize));
  }
  return out + stream.flush();
}

function renderWithSplits(text: string, splits: number[]): string {
  const stream = new MarkdownStream(true);
  let out = "";
  let cursor = 0;
  for (const at of [...splits].sort((a, b) => a - b)) {
    const end = Math.min(Math.max(at, cursor), text.length);
    out += stream.push(text.slice(cursor, end));
    cursor = end;
  }
  out += stream.push(text.slice(cursor));
  return out + stream.flush();
}

const SAMPLES: Record<string, string> = {
  plain: "Just an ordinary sentence with no markup at all.\n",
  heading: "# Title\n\nSome body text.\n",
  deepHeading: "### Third level\ntext\n",
  bold: "This is **very** important, and **so is this**.\n",
  codeSpan: "Run `npm run build` and then `node dist/index.js`.\n",
  bullets: "- first\n- second\n- third\n",
  ordered: "1. first\n2. second\n10. tenth\n",
  quote: "> quoted line\nnormal line\n",
  fence: "Before.\n```ts\nconst x = 1;\nif (x) console.log(x);\n```\nAfter.\n",
  fenceNoLang: "```\nplain code\n```\n",
  mixed:
    "# Report\n\nThe **key** finding is in `results.json`.\n\n" +
    "1. load the file\n2. run `analyse()`\n\n```sh\nnpm test\n```\n\n> caveat: small sample\n",
  asterisks: "2 * 3 * 4 is twelve, and a*b is a product.\n",
  underscores: "snake_case_name and __dunder__ stay literal.\n",
  starAtEnd: "trailing star *",
  hashNoSpace: "#hashtag is not a heading\n",
  emptyLines: "one\n\n\ntwo\n",
  noTrailingNewline: "no newline at the end",
  // A response cut off inside a code block, as max_tokens produces.
  unclosedFence: "```ts\nconst x = 1;\nconst y =",
  unclosedFenceNoLang: "```\nhalf a line",
  unclosedBoldAtEnd: "this is **unfinished",
  unclosedCodeSpan: "this is `unfinished",
  longOrderedMarker: "1234567. item\n",
  veryLongOrderedMarker: "123456789. item\n",
  notAMarker: "1234567890123 is a number, not a list\n",
};

describe("R14 rendering is chunk-invariant", () => {
  it("produces the same bytes however the stream is split", () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      const whole = render(text, Math.max(text.length, 1));

      for (const size of [1, 2, 3, 5, 7, 13]) {
        expect(render(text, size), `${name} differed at chunk size ${size}`).toBe(whole);
      }
    }
  });

  it("produces the same bytes for arbitrary split points", () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      const whole = render(text, Math.max(text.length, 1));

      // Deterministic pseudo-random split points, so a failure is reproducible.
      for (let seed = 1; seed <= 25; seed++) {
        const splits = Array.from(
          { length: 6 },
          (_, i) => ((seed * 7 + i * 11) * 13) % (text.length + 1),
        );
        expect(renderWithSplits(text, splits), `${name} differed for seed ${seed}`).toBe(whole);
      }
    }
  });

  it("splits a ** marker across chunks without emitting a stray asterisk", () => {
    const text = "a **bold** b\n";

    expect(render(text, 1)).toBe(render(text, text.length));
    expect(stripAnsi(render(text, 1))).toBe("a bold b\n");
  });

  it("splits a fence marker across chunks", () => {
    const text = "```\ncode\n```\n";

    expect(render(text, 1)).toBe(render(text, text.length));
    expect(stripAnsi(render(text, 1))).toBe("code\n");
  });
});

describe("R14 rendering preserves content", () => {
  it("leaves prose byte-identical apart from styling", () => {
    const text = SAMPLES["plain"] as string;

    expect(render(text, 3)).toBe(text);
  });

  it("consumes only marker characters", () => {
    expect(stripAnsi(render("# Title\n", 2))).toBe("Title\n");
    expect(stripAnsi(render("This is **bold** here\n", 2))).toBe("This is bold here\n");
    expect(stripAnsi(render("Use `code` now\n", 2))).toBe("Use code now\n");
    expect(stripAnsi(render("- item\n", 2))).toBe("- item\n");
    expect(stripAnsi(render("1. item\n", 2))).toBe("1. item\n");
  });

  it("leaves lone asterisks and underscores alone", () => {
    const text = SAMPLES["asterisks"] as string;
    expect(stripAnsi(render(text, 2))).toBe(text);

    const underscored = SAMPLES["underscores"] as string;
    expect(stripAnsi(render(underscored, 2))).toBe(underscored);
  });

  it("does not treat a hash without a space as a heading", () => {
    const text = SAMPLES["hashNoSpace"] as string;

    expect(stripAnsi(render(text, 2))).toBe(text);
  });

  it("emits a held trailing marker on flush rather than swallowing it", () => {
    expect(stripAnsi(render("trailing star *", 1))).toBe("trailing star *");
    expect(stripAnsi(render("unclosed **bold", 1))).toBe("unclosed bold");
  });

  it("keeps code block content verbatim, markers aside", () => {
    const rendered = render("```py\nx = 1 * 2\n# not a heading\n```\n", 3);

    expect(stripAnsi(rendered)).toBe("x = 1 * 2\n# not a heading\n");
  });

  it("does not let a code span swallow the rest of the line", () => {
    expect(stripAnsi(render("a `b` c `d` e\n", 2))).toBe("a b c d e\n");
  });
});

describe("R14 styling is opt-in", () => {
  it("passes text through untouched when colour is off", () => {
    for (const text of Object.values(SAMPLES)) {
      expect(render(text, 3, false)).toBe(text);
    }
  });

  it("never leaves a style open at the end of the output", () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      const rendered = render(text, 3);
      const codes = rendered.match(ANSI_PATTERN);
      if (codes === null) continue;

      expect(codes.at(-1), `${name} ended with an unclosed style`).toBe(RESET);
    }
  });
});
