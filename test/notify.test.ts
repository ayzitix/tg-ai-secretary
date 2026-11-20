import { describe, expect, it } from "vitest";
import { formatOwnerNotification, isForwardRequest, parseReply } from "../src/notify";

describe("parseReply", () => {
  it("returns plain text untouched", () => {
    expect(parseReply("Олексій зайнятий, я його ШІ-помічник.")).toEqual({
      text: "Олексій зайнятий, я його ШІ-помічник.",
      notify: null,
    });
  });

  it("strips the notify marker and returns the summary", () => {
    const parsed = parseReply(
      "Передав Олексію, він побачить.\n\n[NOTIFY] Просить передзвонити щодо рахунку за жовтень до п'ятниці.",
    );
    expect(parsed.text).toBe("Передав Олексію, він побачить.");
    expect(parsed.notify).toBe("Просить передзвонити щодо рахунку за жовтень до п'ятниці.");
  });

  it("keeps the summary when the model sent only the marker", () => {
    const parsed = parseReply("[NOTIFY] Терміново: змінили дедлайн на завтра.");
    expect(parsed.text).toBe("");
    expect(parsed.notify).toBe("Терміново: змінили дедлайн на завтра.");
  });

  it("drops an empty marker without leaving it in the text", () => {
    const parsed = parseReply("Гаразд, Олексій відповість.\n[NOTIFY]   ");
    expect(parsed.text).toBe("Гаразд, Олексій відповість.");
    expect(parsed.notify).toBeNull();
  });
});

describe("isForwardRequest", () => {
  it("detects explicit requests to pass a message on", () => {
    expect(isForwardRequest("Так, передай йому, будь ласка")).toBe(true);
    expect(isForwardRequest("Передайте йому рахунок до п'ятниці")).toBe(true);
    expect(isForwardRequest("Скажи йому, що я передзвоню")).toBe(true);
    expect(isForwardRequest("Нехай зв'яжеться зі мною")).toBe(true);
  });

  it("detects short agreements", () => {
    expect(isForwardRequest("так")).toBe(true);
    expect(isForwardRequest("Ок!")).toBe(true);
    expect(isForwardRequest("добре, давай")).toBe(true);
  });

  it("does not treat ordinary messages as consent", () => {
    expect(isForwardRequest("Олексію, треба узгодити рахунок за жовтень")).toBe(false);
    expect(isForwardRequest("Дякую, все зрозуміло")).toBe(false);
    expect(isForwardRequest("Отримав повідомлення, подивлюсь")).toBe(false);
    expect(isForwardRequest("https://vm.tiktok.com/ZM123abc/")).toBe(false);
  });
});

describe("formatOwnerNotification", () => {
  it("uses the public username and a t.me link", () => {
    const text = formatOwnerNotification({
      title: "Марія",
      username: "maria_dev",
      chatId: 222,
      summary: "Просить рахунок до п'ятниці.",
    });
    expect(text).toContain("Марія (@maria_dev)");
    expect(text).toContain("https://t.me/maria_dev");
    expect(text).toContain("Просить рахунок до п'ятниці.");
  });

  it("falls back to tg:// link when the username is missing", () => {
    const text = formatOwnerNotification({
      title: "Андрій",
      username: null,
      chatId: 333,
      summary: "Питання по договору.",
    });
    expect(text).toContain("Андрій");
    expect(text).toContain("tg://user?id=333");
    expect(text).not.toContain("@");
  });

  it("normalises a username that already starts with @", () => {
    const text = formatOwnerNotification({
      title: null,
      username: "@maria_dev",
      chatId: 222,
      summary: "Тест.",
    });
    expect(text.startsWith("@maria_dev")).toBe(true);
    expect(text).toContain("https://t.me/maria_dev");
  });
});
