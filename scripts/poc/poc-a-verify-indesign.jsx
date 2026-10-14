/**
 * PoC-A manual gate: open edited IDML in InDesign and record whether a repair dialog appears.
 *
 * Usage (with InDesign installed):
 *   1. Run: npm run poc:idml:a
 *   2. In InDesign: File → Scripts → User → poc-a-verify-indesign.jsx
 *      Or drag this file onto InDesign.
 *
 * Writes: artifacts/poc/poc-a/indesign-open-result.txt (next to repo when scriptFolder is set)
 */
#targetengine "PoC_A_Verify"

(function () {
  var RESULT_MARKER = 'INDESIGN_OPEN_RESULT=';
  var editedName = 'plain.edited.idml';

  /** @type {File} */
  var scriptFile = File($.fileName);
  var repoRoot = scriptFile.parent.parent.parent; // scripts/poc -> repo
  var edited = new File(repoRoot.fsName + '/artifacts/poc/poc-a/' + editedName);
  var out = new File(repoRoot.fsName + '/artifacts/poc/poc-a/indesign-open-result.txt');

  function writeResult(status, detail) {
    out.parent.create();
    out.encoding = 'UTF-8';
    out.open('w');
    out.writeln(RESULT_MARKER + status);
    out.writeln('detail=' + detail);
    out.writeln('file=' + edited.fsName);
    out.writeln('indesign=' + app.version);
    out.writeln('when=' + new Date().toString());
    out.close();
  }

  if (!edited.exists) {
    writeResult('FAIL', 'Edited IDML not found. Run npm run poc:idml:a first.');
    alert('PoC-A: missing ' + edited.fsName);
    return;
  }

  var doc;
  try {
    doc = app.open(edited, false);
  } catch (e) {
    writeResult('FAIL', 'app.open threw: ' + e);
    alert('PoC-A: open failed — ' + e);
    return;
  }

  var repair = false;
  try {
    if (doc.recompose) doc.recompose();
    // Heuristic: modified flag after open without edits suggests conversion/repair activity
    repair = doc.modified === true;
  } catch (e2) {
    writeResult('FAIL', 'post-open check: ' + e2);
    try {
      doc.close(SaveOptions.NO);
    } catch (e3) {}
    return;
  }

  writeResult(repair ? 'FAIL_REPAIR_OR_MODIFIED' : 'PASS', repair ? 'Document opened as modified (possible repair/conversion)' : 'Opened clean, not modified');
  doc.close(SaveOptions.NO);
  alert('PoC-A verify done. See indesign-open-result.txt');
})();
