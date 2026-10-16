/**
 * PoC-B step 3 (Adobe): open patched IDML, save native INDD, re-export IDML for diff.
 */
#targetengine "PoC_B_Step3"

(function () {
  app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;

  var scriptFile = File($.fileName);
  var repoRoot = scriptFile.parent.parent.parent;
  var pocDir = new Folder(repoRoot.fsName + '/artifacts/poc/poc-b');
  var log = new File(pocDir.fsName + '/poc-b-step3.log');

  function writeln(msg) {
    log.encoding = 'UTF-8';
    if (!log.exists) log.open('w');
    else log.open('a');
    log.writeln(msg);
    log.close();
  }

  var editedIdml = new File(pocDir.fsName + '/step2-edited.idml');
  var outIndd = new File(pocDir.fsName + '/step3-roundtrip.indd');
  var verifyIdml = new File(pocDir.fsName + '/step3-reexport.idml');

  if (!editedIdml.exists) {
    writeln('FAIL missing ' + editedIdml.fsName);
    throw new Error('run poc-b step 2 first');
  }

  var doc = app.open(editedIdml, false);
  var modifiedAtOpen = doc.modified;
  try {
    doc.save(outIndd);
    writeln('saved INDD ' + outIndd.fsName);
    doc.exportFile(ExportFormat.INDESIGN_MARKUP, verifyIdml);
    writeln('re-exported IDML ' + verifyIdml.fsName);
    writeln('modifiedAtOpen=' + modifiedAtOpen);
    writeln('PASS step3 indesign=' + app.version);
  } catch (e) {
    writeln('FAIL ' + e);
    throw e;
  } finally {
    doc.close(SaveOptions.NO);
  }
})();
