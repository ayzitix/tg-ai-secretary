import { describe, expect, it } from "vitest";
import type { MessageRow } from "../src/db";
import { sanitize } from "../src/llm";
import { DEFAULT_PROMPT, ENTERTAINMENT_CONTEXT, FORWARD_CONTEXT, buildMessages, isEntertainmentLink, renderPrompt } from "../src/prompt";
import { splitText } from "../src/telegram";

function message(id: number, direction: string, text: string): MessageRow {
  return { id, chat_id: 1, direction, text, ts: id };
}

describe("sanitize", () => {
  it("strips wrapping quotes", () => {
    expect(sanitize('"Привіт, я скоро відповім."')).toBe("Привіт, я скоро відповім.");
  });

  it("drops simple markdown emphasis and headings", () => {
    expect(sanitize("## Заголовок\n**важливо** і __теж__")).toBe("Заголовок\nважливо і теж");
  });

  it("keeps plain text untouched", () => {
    expect(sanitize("Ок, напишу після 18:00.")).toBe("Ок, напишу після 18:00.");
  });
});

describe("buildMessages", () => {
  it("starts with the system prompt and maps directions", () => {
    const result = buildMessages([message(1, "in", "Привіт"), message(2, "out", "Добрий день")]);
    expect(result[0]).toEqual({ role: "system", content: renderPrompt() });
    expect(result[1]).toEqual({ role: "user", content: "Привіт" });
    expect(result[2]).toEqual({ role: "assistant", content: "Добрий день" });
  });

  it("appends owner instructions to the system prompt", () => {
    const result = buildMessages([message(1, "in", "hi")], "Не відповідай довше двох речень.");
    expect(result[0]?.content).toContain(renderPrompt());
    expect(result[0]?.content).toContain("Не відповідай довше двох речень.");
  });

  it("keeps only the last eight history entries", () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      message(index + 1, index % 2 === 0 ? "in" : "out", `msg-${index + 1}`),
    );
    const result = buildMessages(history);
    expect(result).toHaveLength(9);
    expect(result[1]?.content).toBe("msg-5");
    expect(result[8]?.content).toBe("msg-12");
  });

  it("adds the entertainment context only for short-video links", () => {
    const withLink = buildMessages([message(1, "in", "https://vm.tiktok.com/ZM123abc/")]);
    expect(withLink).toHaveLength(3);
    expect(withLink[1]).toEqual({ role: "system", content: ENTERTAINMENT_CONTEXT });

    const withoutLink = buildMessages([message(1, "in", "Надішли, будь ласка, рахунок")]);
    expect(withoutLink).toHaveLength(2);
    expect(withoutLink[1]?.role).toBe("user");
  });

  it("adds the forward context only when the peer agreed to forward", () => {
    const history = [message(1, "in", "Так, передай йому")];
    const withForward = buildMessages(history, null, { forwardRequested: true });
    expect(withForward.some((item) => item.content === FORWARD_CONTEXT)).toBe(true);

    const withoutForward = buildMessages(history, null, { forwardRequested: false });
    expect(withoutForward.some((item) => item.content === FORWARD_CONTEXT)).toBe(false);
  });

  it("mentions the assistant identity instead of impersonating the owner", () => {
    expect(DEFAULT_PROMPT).toContain("ШІ-помічник");
    expect(DEFAULT_PROMPT).not.toContain("ШІ-помічниця");
    expect(DEFAULT_PROMPT).not.toContain("Never mention that you are an AI");
  });

  it("substitutes the owner name into the prompt", () => {
    const rendered = renderPrompt("Марія");
    expect(rendered).toContain("Марія");
    expect(rendered).not.toContain("{{name}}");
  });
});

describe("isEntertainmentLink", () => {
  it("detects TikTok, Reels and Shorts links", () => {
    expect(isEntertainmentLink("глянь https://vm.tiktok.com/ZM123/")).toBe(true);
    expect(isEntertainmentLink("https://www.instagram.com/reel/Cx1/")).toBe(true);
    expect(isEntertainmentLink("https://youtube.com/shorts/abc")).toBe(true);
  });

  it("ignores ordinary messages and long-form YouTube", () => {
    expect(isEntertainmentLink("Коли будеш на зв'язку?")).toBe(false);
    expect(isEntertainmentLink("https://youtube.com/watch?v=1")).toBe(false);
  });
});

describe("splitText", () => {
  it("returns a single chunk for short text", () => {
    expect(splitText("коротко")).toEqual(["коротко"]);
  });

  it("splits long text into pieces under the limit", () => {
    const text = "речення. ".repeat(200);
    const chunks = splitText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("returns nothing for blank text", () => {
    expect(splitText("   ")).toEqual([]);
  });
});
