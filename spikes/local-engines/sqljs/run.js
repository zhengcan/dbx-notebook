(async () => {
  try {
    const t0 = performance.now();
    const SQL = await initSqlJs({ locateFile: f => "node_modules/sql.js/dist/" + f });
    const db = new SQL.Database();
    db.run("CREATE TABLE t(a INT, b TEXT); INSERT INTO t VALUES (1,'x'),(2,'y');");
    const r = db.exec("SELECT sum(a), count(*) FROM t");
    console.log("INIT_OK " + JSON.stringify(r[0].values) + " " + Math.round(performance.now() - t0) + "ms");
  } catch (e) { console.log("INIT_FAIL " + e); }
})();
