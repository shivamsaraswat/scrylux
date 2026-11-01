// A test child that answers with the names of the environment variables it was given, so that a test can show that the
// extraction child gets none (Phase 3 Milestone 3, research #3). It speaks the same protocol as the real one. Never built.
process.once('message', () => {
  const blocks = [{ text: JSON.stringify(Object.keys(process.env).sort()) }];
  process.send?.({ ok: true, blocks, pagesWithoutText: null }, () => process.exit(0));
});
