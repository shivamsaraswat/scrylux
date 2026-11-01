// A test child that is killed from outside, as the kernel's out-of-memory killer does. Never built.
process.once('message', () => {
  process.kill(process.pid, 'SIGKILL');
});
