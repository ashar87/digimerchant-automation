import { config } from '../config.js';

/**
 * All dates and times shown to the model must be in the business's timezone, not
 * the server's. A UTC server would otherwise tell the model it is still yesterday
 * during British Summer Time evenings, so "by Friday" resolves a day early, and
 * message timestamps in the transcript would be an hour off the times people
 * actually mean when they say "let's do it after 5".
 */
export function today(tz = config.timezone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/** HH:MM for a WhatsApp timestamp (seconds since epoch). */
export function clockTime(epochSeconds, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(epochSeconds * 1000));
}

/** "Monday" for a yyyy-mm-dd string. Anchored at midday so no timezone can shift the day. */
export function weekday(isoDate, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' })
    .format(new Date(`${isoDate}T12:00:00Z`));
}

/** "Fri 28 Aug" for a due date. */
export function shortDate(isoDate, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}
