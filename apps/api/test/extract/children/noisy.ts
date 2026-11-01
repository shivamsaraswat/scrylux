// A test child that writes to its standard output and error before it answers, as a parsing library might. The worker's
// own output must stay clean of it (SC-008). Never built.
process.once('message', () => {
  process.stdout.write('CANARY-STDOUT-DOCUMENT-TEXT\n');
  process.stderr.write('CANARY-STDERR-DOCUMENT-TEXT\n');
  console.log('CANARY-CONSOLE-DOCUMENT-TEXT');
  process.send?.({ ok: true, blocks: [{ text: 'fine' }], pagesWithoutText: null }, () => process.exit(0));
});
