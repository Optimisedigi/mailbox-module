import { describe, expect, it } from "vitest";
import { cleanGreetingName, cleanSuggestedSubject, ensureHiGreeting, greetingName, recipientGreetingName } from "@/lib/mail/greeting";

describe("greetingName", () => {
  it("takes the first name from a display name, never from a bare address", () => {
    expect(greetingName('"Hannah Smith" <hannah@othersidegroup.com.au>')).toBe("Hannah");
    expect(greetingName("Jo <jo@x.com>, Sam <sam@y.com>")).toBe("Jo");
    expect(greetingName("jo@x.com")).toBe("");
    expect(greetingName("jo@x.com <jo@x.com>")).toBe("");
    expect(greetingName("")).toBe("");
  });
});

describe("ensureHiGreeting", () => {
  it("keeps a Hi greeting as written", () => {
    expect(ensureHiGreeting("Hi Sam,\n\nThursday works.", "Samantha")).toBe("Hi Sam,\n\nThursday works.");
  });

  it("turns other greetings into Hi", () => {
    expect(ensureHiGreeting("Dear Hannah,\n\nThanks.", "Hannah")).toBe("Hi Hannah,\n\nThanks.");
    expect(ensureHiGreeting("Hello Jo, thanks for this.", "")).toBe("Hi Jo, thanks for this.");
    expect(ensureHiGreeting("Good morning Jo,\n\nx", "")).toBe("Hi Jo,\n\nx");
  });

  it("adds Hi and the name when there is no greeting", () => {
    expect(ensureHiGreeting("Thursday works for me.", "Hannah")).toBe("Hi Hannah,\n\nThursday works for me.");
    expect(ensureHiGreeting("\n  Thursday works.", "")).toBe("Hi,\n\nThursday works.");
    // "Hiring" is not a greeting.
    expect(ensureHiGreeting("Hiring is open.", "Jo")).toBe("Hi Jo,\n\nHiring is open.");
  });
});

describe("cleanSuggestedSubject", () => {
  it("returns one clean line", () => {
    expect(cleanSuggestedSubject('"Catch-up next week"')).toBe("Catch-up next week");
    expect(cleanSuggestedSubject("Subject: Q3 results\nextra")).toBe("Q3 results extra");
    expect(cleanSuggestedSubject(undefined)).toBe("");
  });
});

describe("recipientGreetingName", () => {
  const contacts = [{ email: "sam@x.com", name: "Sam Lee" }, { email: "info@y.com", name: "" }];

  it("uses the typed display name, else the contact's name, for one To recipient", () => {
    expect(recipientGreetingName("Jo Bloggs <jo@x.com>", contacts)).toBe("Jo");
    expect(recipientGreetingName("Sam@X.com, ", contacts)).toBe("Sam");
    expect(recipientGreetingName("info@y.com", contacts)).toBe("");
    expect(recipientGreetingName("sam@x.com", null)).toBe("");
  });

  it("does not pick a name for several recipients or none", () => {
    expect(recipientGreetingName("sam@x.com, jo@x.com", contacts)).toBe("");
    expect(recipientGreetingName("", contacts)).toBe("");
  });

  it("keeps only first-name-like text from the browser", () => {
    expect(cleanGreetingName("Sam")).toBe("Sam");
    expect(cleanGreetingName("<script>")).toBe("");
    expect(cleanGreetingName(42)).toBe("");
  });
});

describe("ensureHiGreeting with a known name", () => {
  it("adds the name to a greeting that has none", () => {
    expect(ensureHiGreeting("Hi,\n\nThursday works.", "Sam")).toBe("Hi Sam,\n\nThursday works.");
    expect(ensureHiGreeting("Hello there!\n\nx", "Sam")).toBe("Hi Sam,\n\nx");
    expect(ensureHiGreeting("Hi Samantha,\n\nx", "Sam")).toBe("Hi Samantha,\n\nx");
    expect(ensureHiGreeting("Hi,\n\nx", "")).toBe("Hi,\n\nx");
  });
});
