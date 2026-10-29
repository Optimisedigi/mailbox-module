import type { GlobalConfig } from "payload";

/**
 * Shared Google Calendar connection (one Google account). Mail uses it only
 * when it is the same address as the mailbox on screen, for invite answers and
 * "Add calendar invite".
 */
export const CalendarAuth: GlobalConfig = {
  slug: "calendar-auth",
  label: "Google Calendar",
  admin: {
    group: "Mail",
    description: "Connect the Google account whose calendar Mail may read and write.",
  },
  access: {
    read: ({ req }) => req.user?.role === "admin",
    update: ({ req }) => req.user?.role === "admin",
  },
  fields: [
    { name: "refreshToken", type: "text", admin: { hidden: true } },
    { name: "connectedEmail", type: "text", admin: { readOnly: true, description: "Google account connected for Calendar access" } },
    { name: "connectedAt", type: "date", admin: { readOnly: true, date: { pickerAppearance: "dayAndTime" } } },
    { name: "connectCalendar", type: "ui", admin: { components: { Field: "./components/ConnectCalendarButton" } } },
  ],
};
