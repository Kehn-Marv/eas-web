import test from "node:test";
import assert from "node:assert/strict";
import {
  hasBareLatexTrigger,
  hasInlineMathCandidate,
  normalizeMathMarkup,
} from "../lib/latex-normalize";
import { hasMarkdownMath } from "../lib/latex";

// ---------------------------------------------------------------------------
// formulas the model did not delimit at all
// ---------------------------------------------------------------------------

test("bare LaTeX in prose is wrapped", () => {
  assert.equal(
    normalizeMathMarkup("De Morgan's law \\overline{A+B}=\\bar{A}\\bar{B} is essential."),
    "De Morgan's law $\\overline{A+B}=\\bar{A}\\bar{B}$ is essential.",
  );
  assert.equal(
    normalizeMathMarkup("Then \\frac{a}{b} = c holds."),
    "Then $\\frac{a}{b} = c$ holds.",
  );
  assert.equal(
    normalizeMathMarkup("The answer is \\boxed{42}."),
    "The answer is $\\boxed{42}$.",
  );
});

test("bare LaTeX stops at the first English word", () => {
  assert.equal(
    normalizeMathMarkup("The value \\alpha is large here."),
    "The value $\\alpha$ is large here.",
  );
});

test("a bare environment is promoted to display math exactly once", () => {
  const result = normalizeMathMarkup(
    "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}",
  );

  assert.ok(result.includes("$$\n\\begin{aligned}"));
  assert.ok(
    !result.includes("$\\begin{aligned}$"),
    "the environment must not also be wrapped as inline math",
  );
});

test("bare LaTeX inside a table cell stays inside its cell", () => {
  assert.equal(
    normalizeMathMarkup("| Formula | Description |\n| --- | --- |\n| \\sqrt{x^2+1} | Norm |"),
    "| Formula | Description |\n| --- | --- |\n| $\\sqrt{x^2+1}$ | Norm |",
  );
});

// ---------------------------------------------------------------------------
// formulas the model put in a code span
// ---------------------------------------------------------------------------

test("a code span holding only LaTeX becomes maths", () => {
  assert.equal(
    normalizeMathMarkup("De Morgan's law `\\overline{A+B}=\\bar{A}\\bar{B}` is essential."),
    "De Morgan's law $\\overline{A+B}=\\bar{A}\\bar{B}$ is essential.",
  );
  assert.equal(
    normalizeMathMarkup("Formula `$\\bar{A}$` above."),
    "Formula $\\bar{A}$ above.",
  );
});

test("a code span holding code stays code", () => {
  for (const input of [
    "Use the `$PATH` variable.",
    "Run `npm run dev` to start.",
    "Notice the line `a[i] = b + 1`.",
  ]) {
    assert.equal(normalizeMathMarkup(input), input);
  }
});

// ---------------------------------------------------------------------------
// backslashes that are not maths
// ---------------------------------------------------------------------------

test("paths, regexes and Markdown escapes are left alone", () => {
  for (const input of [
    "Put the file in the C:\\Users\\frank\\Desktop folder.",
    "Use \\d+ to match numbers.",
    "Literal \\*asterisks\\* and \\_underscores\\_.",
    "References \\[1\\] point to this conclusion.",
  ]) {
    assert.equal(normalizeMathMarkup(input), input);
  }
});

test("fenced code is never rewritten", () => {
  const input = "```tex\n\\(x+y\\)\n```";
  assert.equal(normalizeMathMarkup(input), input);
});

// ---------------------------------------------------------------------------
// delimiters the model chose instead of $
// ---------------------------------------------------------------------------

test("backslash delimiters become dollars without padding", () => {
  assert.equal(
    normalizeMathMarkup("Therefore \\( x + y = z \\) holds."),
    "Therefore $x + y = z$ holds.",
  );
  assert.equal(
    normalizeMathMarkup("From \\(a\\) to \\(b\\), then to \\(c\\)."),
    "From $a$ to $b$, then to $c$.",
  );
});

test("a doubly-escaped delimiter is repaired", () => {
  assert.equal(
    normalizeMathMarkup("Therefore \\\\(x+y\\\\) holds."),
    "Therefore $x+y$ holds.",
  );
});

test("an inline paren formula never merges two table cells", () => {
  const input = "| \\(a | b\\) |\n| --- |\n| x |";
  assert.equal(normalizeMathMarkup(input), input);
});

test("a loose $ pair is tightened rather than dropped", () => {
  assert.equal(
    normalizeMathMarkup("Therefore $ x + y $ holds."),
    "Therefore $x + y$ holds.",
  );
});

// ---------------------------------------------------------------------------
// dollars that are money
// ---------------------------------------------------------------------------

test("currency is escaped so remark-math cannot swallow it", () => {
  assert.equal(
    normalizeMathMarkup("Price $100 base, plus $20 shipping and $5 tax."),
    "Price \\$100 base, plus \\$20 shipping and $5 tax.",
  );
  assert.equal(
    normalizeMathMarkup("It costs $5 and the value of $x$ is 2."),
    "It costs \\$5 and the value of $x$ is 2.",
  );
});

test("real formulas survive the same pass", () => {
  for (const input of [
    "Suppose $x^2+y^2=z^2$ holds.",
    "Let $x$ be a variable, $y$ a constant.",
    "$\\text{speed} = \\frac{s}{t}$",
    "Given $v = s/t$ to solve.",
    "$$\n\\overline{A+B}=\\bar{A}\\bar{B}\n$$",
  ]) {
    assert.equal(normalizeMathMarkup(input), input);
  }
});

test("an unfinished formula is left alone while streaming", () => {
  assert.equal(normalizeMathMarkup("Let $x^2"), "Let $x^2");
});

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

test("normalisation is idempotent", () => {
  for (const input of [
    "De Morgan's law \\overline{A+B}=\\bar{A}\\bar{B} is essential.",
    "Price $100 base, plus $20 shipping.",
    "Therefore \\(x+y\\) holds.",
    "\\begin{aligned}\na &= b\n\\end{aligned}",
    "De Morgan's law `\\bar{A}` above.",
  ]) {
    const once = normalizeMathMarkup(input);
    assert.equal(normalizeMathMarkup(once), once, input);
  }
});

test("routing agrees with what normalisation produces", () => {
  const shouldRender = [
    "De Morgan's law \\overline{A+B}=\\bar{A}\\bar{B} is essential.",
    "De Morgan's law `\\overline{A+B}` is essential.",
    "Therefore $ x + y $ holds.",
    "The answer is \\boxed{42}.",
  ];
  for (const input of shouldRender) {
    assert.equal(hasMarkdownMath(input), true, input);
    assert.notEqual(normalizeMathMarkup(input), input, input);
  }

  const shouldNot = [
    "The price is $5 and $10.",
    "Put the file in the C:\\Users\\frank\\Desktop folder.",
    "Run `npm run dev` to start.",
  ];
  for (const input of shouldNot) {
    assert.equal(hasMarkdownMath(input), false, input);
  }
});

test("the routing predicates answer on their own terms", () => {
  assert.equal(hasInlineMathCandidate("Let $x=1$ hold"), true);
  assert.equal(hasInlineMathCandidate("Tickets cost $5 and $10."), false);
  assert.equal(hasInlineMathCandidate("no dollars here"), false);

  assert.equal(hasBareLatexTrigger("Denote with \\overline{A}"), true);
  assert.equal(hasBareLatexTrigger("C:\\Users\\frank"), false);
  assert.equal(hasBareLatexTrigger("no backslash"), false);
});
