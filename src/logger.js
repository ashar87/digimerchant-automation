const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

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
