const child_process = require("child_process")
  , os = require('os')
  , path = require('path')
  , EventEmitter = require("events")
  , BdpTaskAdapter = require("@big-data-processor/task-adapter-base")
  , utilities = require("@big-data-processor/utilities")
  , sleep = utilities.sleep
  , memHumanize = utilities.humanizeMemory
  , isSystemPath = utilities.isSystemPath
  , fse = utilities.fse
  , spawnProcessAsync = utilities.spawnProcessAsync;


class BdpDockerAdapter extends BdpTaskAdapter {
  constructor(opt) {
    opt.adapterName = "Docker";
    opt.adapterAuthor = "Chi Yang: chiyang1118@gmail.com";
    opt.dockerPath = opt.dockerPath || 'docker';
    super(opt);
    this.dockerPath = this.options.dockerPath;
    this.options.tmpfs = this.options.tmpfs || undefined;
    this.detach = this.options.detach && this.options.detach.toString() === 'true' ? true : false;
    this.options.stdoeMode = this.detach ? "watch" : "pipe";
  }
  async beforeExit() {
    const stopPromises = [];
    for (const jobId of this.runningJobs.keys()) {
      process.stderr.write("[" + new Date().toString() + "] Stop container: " + jobId + "\n");
      stopPromises.push(
        spawnProcessAsync(this.dockerPath, ['stop', jobId], 'stop-container', {mode: 'pipe', verbose: false, shell: true})
          .then(proc => {
            if (proc.exitCode !== 0) { throw 'error stopping container'}
          }).catch(() => this.emitJobStatus(jobId, -2, null)));
      if (stopPromises.length >= 5) {
        await (Promise.all(stopPromises).catch(console.log));
        stopPromises.length = 0;
      }
    }
  }
  async determineJobProxy(jobObj) {
    if (!jobObj.proxy || !jobObj.proxy.containerPort) { return null; }
    let thePort, theIP, requestCounter = 0;
    process.stdout.write(`[task-adapter-docker] Get the proxy port from docker ...\n`);
    while (!thePort && requestCounter < 20 ) {
      await sleep(500);
      const getPort = await spawnProcessAsync(this.dockerPath, ['port', jobObj.jobId, jobObj.proxy.containerPort], 'get-container-port', {mode: 'memory'});
      if (getPort.exitCode === 0) {
        try {
          thePort = parseInt(getPort.stdout.trim().split(':')[1]);
          theIP = getPort.stdout.trim().split(':')[0];
          if (Number.isNaN(thePort)) { thePort = null; }
        } catch(err) {}
      }
      requestCounter ++;
    }
    if (thePort) {
      process.stdout.write(`[task-adapter-docker] The port is ${thePort}\n`);
    } else {
      process.stdout.write(`[task-adapter-docker] Stop the web proxy for this result.\n`);
    }
    thePort ? Object.assign({}, jobObj.proxy, {port: thePort, ip: theIP}) : null;
    if (!thePort) { return null; }
    return {
      protocol: jobObj.proxy.protocol,
      ip: '127.0.0.1',
      port: thePort || undefined,
      pathRewrite: jobObj.proxy.pathRewrite,
      entryPath: jobObj.proxy.entryPath,
      containerPort: jobObj.proxy.containerPort
    };
  }

  async jobDeploy(jobObj) {
    const jobId = jobObj.jobId;
    const runningJob = {
      runningJobId: '',
      stdoutStream: null,
      stderrStream: null,
      jobEmitter: new EventEmitter,
      isRunning: false
    };
    const RunningProcess = child_process.spawn(this.dockerPath, jobObj.args, {
      cwd: jobObj.option.cwd || this.options.cwd || process.cwd(),
      shell: true,
      env: process.env
    });
    runningJob.runningJobId = RunningProcess.pid;
    if (!this.detach) {
      RunningProcess.on("exit", (code, signal) => this.emitJobStatus(jobObj.jobId, code, signal).catch(console.log));
      runningJob.stdoutStream = RunningProcess.stdout;
      runningJob.stderrStream = RunningProcess.stderr;
    }
    return runningJob;
  }
  async jobOverrides(jobObj) {
    jobObj.cpus = jobObj.option.cpus;
    const {value, unit} = memHumanize(jobObj.option.mem, 0);
    jobObj.mem = String(value) + unit.toLowerCase();
    jobObj.option.volumeMappings = Array.isArray(jobObj.option.volumeMappings) ? jobObj.option.volumeMappings.filter(map => map ? true : false) : [];
    if (os.platform() !== 'win32' && Array.isArray(jobObj.option.volumeMappings)) {
      const volumeMappings = jobObj.option.volumeMappings;
      for (let i = 0; i < volumeMappings.length; i ++) {
        const eachVolMaps = volumeMappings[i].split(':');
        if (!Array.isArray(eachVolMaps) || eachVolMaps.length < 2) {
          throw `Invalid VolumeMapping: '${volumeMappings[i]}'` + '\n'
            + `The correct volume mapping has at least two fields separated by colon characters (:)`;
        }
        const hostVolumePath = eachVolMaps[0];
        try {
          const stats = await fse.stat(hostVolumePath);
          const bdpUser = os.userInfo();
          if (stats.uid !== bdpUser.uid && stats.gid !== bdpUser.gid) {
            throw `The host volume ${hostVolumePath} cannot be manipulated by the bdp server account ${bdpUser.username} (uid or gid is not the same.).`;
          }
          const checkPath = isSystemPath(hostVolumePath);
          if (checkPath.isSystemPath) {
            console.log(`Volume mapping changed from '${volumeMappings[i]}' to '${eachVolMaps[0]}:${eachVolMaps[1]}:ro' because you are mapping BDP system files to containers.`)
            volumeMappings[i] = `${eachVolMaps[0]}:${eachVolMaps[1]}:ro`;
          }
        } catch(e) {
          console.log(e);
          throw `We failed to do the volume mappings.`;
        }
      }
    }
    if (!this.argTemplate) {
      this.argTemplate = await fse.readFile(path.join(__dirname, 'docker-arg-recipe.yaml'), "utf8");
    }
    jobObj.option.stdoeMode = this.options.stdoeMode;
    jobObj.option.detach = this.detach;
    jobObj = await super.parseRecipe(jobObj, this.argTemplate);
    jobObj.command = this.dockerPath + " " + jobObj.args.join(" ");
    return jobObj;
  }
  async recordJobLogs(jobObj) {
    const jobId = jobObj.jobId;
    const currentDate = (new Date()).toISOString();
    let queryJobLog;
    if (jobObj.stdoeTimeStamp === undefined) {
      queryJobLog = await spawnProcessAsync(this.dockerPath,
        ['logs', jobId, '--until', currentDate.toString()],
        'get-container-logs', {mode: 'memory'});
    } else {
      queryJobLog = await spawnProcessAsync(this.dockerPath, ['logs', jobId, '--since', jobObj.stdoeTimeStamp, '--until', currentDate.toString()], 'get-container-logs', {mode: 'memory'});
    }
    jobObj.stdoeTimeStamp = currentDate;
    await (new Promise((resolve) => {
      try {
        fse.createWriteStream(jobObj.stdout, {flags: 'a'}).end((queryJobLog.stdout + queryJobLog.stderr), resolve);
      } catch(e) {
        console.log(e);
        return reject(e);
      }
    }));
  }
  async detectJobStatus() {
    if (!this.detach) { return; }
    for (const jobId of this.runningJobs.keys()) {
      const jobObj = this.getJobById(jobId);
      if (!jobObj) {
        console.log(`Cannot find the job definition object of ${jobId}`);
        continue;
      }
      const queryJobProc = await spawnProcessAsync(this.dockerPath, ['inspect', jobId, `--format={{.State.Status}}`], 'get-container-status', {mode: 'memory'});
      if (queryJobProc.exitCode !== 0) { continue; }
      const jobStatus = queryJobProc.stdout.replace(/\n/g, '');
      let queryJobExitCode, exitCode;
      switch (jobStatus) {
        case 'running':
          const runningJob = this.runningJobs.get(jobId);
          runningJob.isRunning = true;
          await this.recordJobLogs(jobObj);
          break;
        case 'exited':
          await this.recordJobLogs(jobObj);
          queryJobExitCode = await spawnProcessAsync(this.dockerPath, ['inspect', jobId, `--format={{.State.ExitCode}}`], 'get-exit-code', {mode: 'memory'});
          exitCode = Number(queryJobExitCode.stdout.replace(/\n/g, ""));
          if (isNaN(exitCode)) { exitCode = 3; }
          await this.emitJobStatus(jobId, exitCode, null);
          break;
        case 'dead':
          await this.recordJobLogs(jobObj);
          queryJobExitCode = await spawnProcessAsync(this.dockerPath, ['inspect', jobId, `--format={{.State.ExitCode}}`], 'get-exit-code', {mode: 'memory'});
          exitCode = Number(queryJobExitCode.stdout.replace(/\n/g, ""));
          if (isNaN(exitCode)) { exitCode = 3; }
          await this.emitJobStatus(jobId, exitCode, null);
          break;
      }
    }
  }
}
module.exports = BdpDockerAdapter;
