const http = require('http');
const server = require('./server');
const crypto = require('./crypto');

describe('audio proxy stream failures', () => {
	test('closes the client when an upstream response is truncated', async () => {
		let upstreamHeaders;
		const upstream = http.createServer((req, res) => {
			upstreamHeaders = req.headers;
			res.writeHead(200, {
				'content-type': 'audio/mpeg',
				'content-length': 100,
			});
			res.write(Buffer.alloc(90));
			res.socket.destroy();
		});
		await new Promise((resolve) =>
			upstream.listen(0, '127.0.0.1', resolve)
		);
		await new Promise((resolve) =>
			server.http.listen(0, '127.0.0.1', resolve)
		);

		global.proxy = null;
		global.hosts = {};
		const source = `http://127.0.0.1:${upstream.address().port}/song.mp3`;
		const encoded = crypto.base64.encode(source);
		const url = `http://music.163.com/package/${encoded}/1.mp3`;
		const result = await new Promise((resolve, reject) => {
			const req = http.get(
				{
					hostname: '127.0.0.1',
					port: server.http.address().port,
					path: new URL(url).pathname,
					headers: { host: 'music.163.com' },
				},
				(res) => {
					res.resume();
					res.once('error', resolve);
					res.once('end', () =>
						reject(new Error('truncated response ended cleanly'))
					);
				}
			);
			req.once('error', resolve);
			setTimeout(
				() => reject(new Error('client remained open')),
				1000
			).unref();
		});

		expect(result).toBeTruthy();
		expect(upstreamHeaders['accept-encoding']).toBe('identity');
		await new Promise((resolve) => upstream.close(resolve));
		await new Promise((resolve) => server.http.close(resolve));
	});
});
