/**
 * PoC-B step 1 (Adobe): ensure plain.indd exists, export IDML to artifacts/poc/poc-b/step1-exported.idml
 */
#targetengine "PoC_B_Step1"

(function () {
  app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;

  var scriptFile = File($.fileName);
  var repoRoot = scriptFile.parent.parent.parent;
  var pocDir = new Folder(repoRoot.fsName + '/artifacts/poc/poc-b');
  pocDir.create();
  var log = new File(pocDir.fsName + '/poc-b-step1.log');

  function writeln(msg) {
    log.encoding = 'UTF-8';
    if (!log.exists) {
      log.open('w');
    } else {
      log.open('a');
    }
    log.writeln(msg);
    log.close();
  }

  var fixtureIdml = new File(repoRoot.fsName + '/public/fixtures/poc/plain.idml');
  var inddFile = new File(pocDir.fsName + '/plain.indd');
  var exportedIdml = new File(pocDir.fsName + '/step1-exported.idml');

  if (!fixtureIdml.exists) {
    writeln('FAIL missing fixture ' + fixtureIdml.fsName);
    throw new Error('missing plain.idml fixture');
  }

  var doc;
  if (inddFile.exists) {
    writeln('open existing ' + inddFile.fsName);
    doc = app.open(inddFile, false);
  } else {
    writeln('create INDD from IDML ' + fixtureIdml.fsName);
    doc = app.open(fixtureIdml, false);
    doc.save(inddFile);
    writeln('saved ' + inddFile.fsName);
  }

  try {
    doc.exportFile(ExportFormat.INDESIGN_MARKUP, exportedIdml);
    writeln('exported ' + exportedIdml.fsName);
    writeln('PASS step1 indesign=' + app.version);
  } catch (e) {
    writeln('FAIL export ' + e);
    throw e;
  } finally {
    doc.close(SaveOptions.NO);
  }
})();
