#!/usr/bin/env node
import { closeDatabase } from "../dist/db.js";
import { deliverPendingNotifications, enqueueUpcomingReminders } from "../dist/debt-notification-repo.js";

try {
  const queued = await enqueueUpcomingReminders();
  const result = await deliverPendingNotifications();
  console.log(JSON.stringify({ queued, ...result }));
  if (!result.configured) {
    console.error("SMTP is not configured; notifications remain queued.");
    process.exitCode = 2;
  } else if (result.failed) {
    process.exitCode = 1;
  }
} finally {
  await closeDatabase();
}
