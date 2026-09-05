const { spawnStdout } = require('./spawn');
const ProcessExitNotSuccessfully = require('./exceptions/ProcessExitNotSuccessfully');

describe('spawnStdout()', () => {
	it('collects stdout', async () => {
		const { stdout } = await spawnStdout(process.execPath, [
			'-e',
			'process.stdout.write("hello")',
		]);

		expect(stdout.toString()).toBe('hello');
	});

	it('collects stderr', async () => {
		const { stderr } = await spawnStdout(process.execPath, [
			'-e',
			'process.stderr.write("warning")',
		]);

		expect(stderr.toString()).toBe('warning');
	});

	it('does not truncate output larger than 5 MB', async () => {
		const { stdout } = await spawnStdout(process.execPath, [
			'-e',
			'process.stdout.write(Buffer.alloc(6000000, 97))',
		]);
		expect(stdout.equals(Buffer.alloc(6000000, 97))).toBe(true);
	});

	it('rejects an unsuccessful process', async () => {
		await expect(
			spawnStdout(process.execPath, ['-e', 'process.exit(2)'])
		).rejects.toBeInstanceOf(ProcessExitNotSuccessfully);
	});

	it('rejects a missing executable', async () => {
		await expect(
			spawnStdout('THIS_COMMAND_SHOULD_NOT_EXIST_5ca1facd')
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	const testUnixOnly = process.platform === 'win32' ? it.skip : it;
	testUnixOnly('rejects a file without execute permission', async () => {
		await expect(
			spawnStdout(`${__dirname}/testdata/test.sh`)
		).rejects.toMatchObject({ code: 'EACCES' });
	});
});
