import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MarkdownRenderer from "@/components/common/MarkdownRenderer";
import { initI18n } from "@/i18n/init";

initI18n();

describe("math Markdown rendering", () => {
  it("renders the plain inline formulas from the reported chat response with KaTeX", async () => {
    const { container } = render(
      <MarkdownRenderer
        content="Suppose there is a function $f(x)$, at $x=2$, the value approaches $5$."
        variant="prose"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex")).toHaveLength(3);
    });
    expect(container).not.toHaveTextContent("$f(x)$");
    expect(container).not.toHaveTextContent("$x=2$");
  });

  it("renders the formulas a model wrote without $ delimiters", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={"De Morgan's law \\overline{A+B}=\\bar{A}\\bar{B} is essential."}
        variant="prose"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
    });
    // KaTeX keeps the source in a MathML <annotation>, so assert on what the
    // reader actually sees rather than on the element's text content.
    expect(container.querySelector(".katex-html")?.textContent).not.toContain(
      "\\overline",
    );
  });

  it("renders a formula the model put in a code span", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={"De Morgan's law `\\overline{A+B}=\\bar{A}\\bar{B}` is essential."}
        variant="prose"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
    });
    expect(container.querySelector("code")).toBeNull();
  });

  it("keeps prices as prices in a message that also renders maths", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={"Let $x=1$. Tickets $5 and $10, total $15."}
        variant="prose"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
        1,
      );
    });
    expect(container).toHaveTextContent("Tickets $5 and $10, total $15.");
  });

  it("renders generated quiz stems and option formulas with KaTeX", async () => {
    const { container } = render(
      <MarkdownRenderer
        content="If $f(x)=x^2$, then $f(2)$ equals $4$. Substituting yields $f(2)=2^2=4$."
        variant="prose"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
        3,
      );
    });
    expect(container).not.toHaveTextContent("$f(x)=x^2$");
    expect(container).not.toHaveTextContent("$4$");
  });
});
