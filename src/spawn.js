const child_process = require('child_process');
const { logScope } = require('./logger');
const ProcessExitNotSuccessfully = require('./exceptions/ProcessExitNotSuccessfully');
const logger = logScope('spawn');

/**
 * @typedef {{stdout: Buffer, stderr: Buffer}} ExecutionResult
 */

/**
 * Spawn a command and get the execution result of that.
 *
 * @param {string} cmd The command. Example: `ls`
 * @param {string[]?} args The arguments list
 * @return {Promise<ExecutionResult>} The execution result (stdout and stderr) of this execution.
 * @example ```js
 * const { stdout, stderr } = await spawnStdout("ls");
 * console.log(stdout.toString());
 * ```
 */
async function spawnStdout(cmd, args = []) {
	return new Promise((resolve, reject) => {
		const stdout = [];
		const stderr = [];
		const spawn = child_process.spawn(cmd, args);

		spawn.on('spawn', () => {
			// Users should acknowledge what command is executing.
			logger.info(`running ${cmd} ${args.join(' ')}`);
		});

		spawn.on('error', (error) => reject(error));
		spawn.on('close', (code) => {
			if (code !== 0) reject(new ProcessExitNotSuccessfully(cmd, code));
			else {
				logger.debug(`process ${cmd} exited successfully`);
				resolve({
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr),
				});
			}
		});

		spawn.stdout.on('data', (stdoutPart) => {
			stdout.push(stdoutPart);
		});
		spawn.stderr.on('data', (stderrPart) => {
			logger.warn(`[${cmd}][stderr] ${stderrPart}`);
			stderr.push(stderrPart);
		});
	});
}

module.exports = { spawnStdout };
