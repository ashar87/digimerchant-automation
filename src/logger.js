// Must match the timezone used for task dates, or log lines cannot be lined up
// against journald and against the due dates the model produced.
const tz = process.env.TZ || 'Europe/London';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const stamp = () => fmt.format(new Date()).replace(',', '');

const write = (level, colour, args) => {
  console.log(`\x1b[90m${stamp()}\x1b[0m ${colour}${level}\x1b[0m`, ...args);
};

export const log = {
  info: (...a) => write('info ', '\x1b[36m', a),
  ok: (...a) => write('ok   ', '\x1b[32m', a),
  warn: (...a) => write('warn ', '\x1b[33m', a),
  error: (...a) => write('error', '\x1b[31m', a),
  debug: (...a) => { if (process.env.DEBUG) write('debug', '\x1b[35m', a); },
};
