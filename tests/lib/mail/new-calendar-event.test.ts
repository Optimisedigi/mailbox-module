import { describe, expect, it, vi } from "vitest";
import { insertCalendarEvent, meetLinkOf, parseNewCalendarEvent } from "@/lib/mail/new-calendar-event";

const base = { date: "2026-11-03", time: "14:30", durationMinutes: 30, timeZone: "Australia/Sydney", sendInvites: false };

describe("parseNewCalendarEvent", () => {
  it("turns the form into a Sydney-time event with unique lowercased guests", () => {
    const result = parseNewCalendarEvent({ ...base, title: " Spend review ", guests: "Melissa <MDavies@northwind.com.au>, mdavies@northwind.com.au, jo@x.com" });
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Spend review",
        // 14:30 AEDT (UTC+11) on 3 Nov.
        start: new Date("2026-11-03T03:30:00.000Z"),
        end: new Date("2026-11-03T04:00:00.000Z"),
        timeZone: "Australia/Sydney",
        guests: ["mdavies@northwind.com.au", "jo@x.com"],
        sendInvites: false,
      },
    });
  });

  it("allows no guests when nothing is sent, and names an untitled event", () => {
    const result = parseNewCalendarEvent(base);
    expect(result.ok && result.value.guests).toEqual([]);
    expect(result.ok && result.value.title).toBe("Meeting");
  });

  it("refuses bad input", () => {
    expect(parseNewCalendarEvent({ ...base, sendInvites: true }).ok).toBe(false);
    expect(parseNewCalendarEvent({ ...base, guests: "not an address" }).ok).toBe(false);
    expect(parseNewCalendarEvent({ ...base, date: "2026-02-30" }).ok).toBe(false);
    expect(parseNewCalendarEvent({ ...base, time: "25:00" }).ok).toBe(false);
    expect(parseNewCalendarEvent({ ...base, durationMinutes: 7 }).ok).toBe(false);
    expect(parseNewCalendarEvent({ ...base, timeZone: "Mars/Base" }).ok).toBe(false);
    expect(parseNewCalendarEvent({ ...base, guests: Array.from({ length: 51 }, (_, i) => `p${i}@x.com`).join(",") }).ok).toBe(false);
  });
});

describe("insertCalendarEvent", () => {
  const event = { title: "T", start: new Date("2026-11-03T03:30:00Z"), end: new Date("2026-11-03T04:00:00Z"), timeZone: "Australia/Sydney", guests: ["jo@x.com"] };

  it("asks for a Meet link and emails nobody when the box is unticked", async () => {
    const insert = vi.fn(async () => ({ data: { id: "e1", htmlLink: "https://calendar/e1", hangoutLink: "https://meet.google.com/abc-defg-hij" } }));
    const calendar = { events: { insert } } as never;
    expect(await insertCalendarEvent(calendar, { ...event, sendInvites: false })).toEqual({
      eventId: "e1",
      eventLink: "https://calendar/e1",
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
    const args = (insert.mock.calls[0] as unknown as [Record<string, unknown> & { requestBody: Record<string, unknown> }])[0];
    expect(args).toMatchObject({ calendarId: "primary", conferenceDataVersion: 1, sendUpdates: "none" });
    expect(args.requestBody).toMatchObject({ attendees: [{ email: "jo@x.com" }], conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } } });
  });

  it("lets Google email the guests when the box is ticked", async () => {
    const insert = vi.fn(async () => ({ data: { id: "e1" } }));
    await insertCalendarEvent({ events: { insert } } as never, { ...event, sendInvites: true });
    expect((insert.mock.calls[0] as unknown as [{ sendUpdates: string }])[0].sendUpdates).toBe("all");
  });

  it("finds the Meet link in the conference entry points too", () => {
    expect(meetLinkOf({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://meet/x" }] } })).toBe("https://meet/x");
    expect(meetLinkOf({})).toBe("");
  });
});
