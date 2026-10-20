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

	test('resumes a stalled audio stream with a range request', async () => {
		const payload = Buffer.from(
			Array.from({ length: 100 }, (_, index) => index)
		);
		const requests = [];
		let stalledSocket;
		const upstream = http.createServer((req, res) => {
			requests.push(req.headers);
			if (requests.length === 1) {
				res.writeHead(200, {
					'content-type': 'audio/mpeg',
					'content-length': payload.length,
				});
				res.write(payload.subarray(0, 40));
				stalledSocket = res.socket;
				return;
			}
			res.writeHead(206, {
				'content-type': 'audio/mpeg',
				'content-length': payload.length - 40,
				'content-range': `bytes 40-${payload.length - 1}/${
					payload.length
				}`,
			});
			res.end(payload.subarray(40));
		});
		await new Promise((resolve) =>
			upstream.listen(0, '127.0.0.1', resolve)
		);
		await new Promise((resolve) =>
			server.http.listen(0, '127.0.0.1', resolve)
		);

		global.proxy = null;
		global.hosts = {};
		const originalIdleTimeout = server.mediaStreamIdleTimeout;
		const originalRetryDelay = server.mediaStreamRetryDelay;
		server.mediaStreamIdleTimeout = 100;
		server.mediaStreamRetryDelay = 10;
		const source = `http://127.0.0.1:${upstream.address().port}/song.mp3`;
		const encoded = crypto.base64.encode(source);
		const url = `http://music.163.com/package/${encoded}/1.mp3`;
		try {
			const body = await new Promise((resolve, reject) => {
				const chunks = [];
				const req = http.get(
					{
						hostname: '127.0.0.1',
						port: server.http.address().port,
						path: new URL(url).pathname,
						headers: { host: 'music.163.com' },
					},
					(res) => {
						res.on('data', (chunk) => chunks.push(chunk));
						res.once('end', () => resolve(Buffer.concat(chunks)));
						res.once('error', reject);
					}
				);
				req.once('error', reject);
				req.setTimeout(2000, () =>
					reject(new Error('client remained open'))
				);
			});

			expect(body).toEqual(payload);
			expect(requests).toHaveLength(2);
			expect(requests[1].range).toBe(`bytes=40-${payload.length - 1}`);
			expect(requests[1]['accept-encoding']).toBe('identity');
		} finally {
			server.mediaStreamIdleTimeout = originalIdleTimeout;
			server.mediaStreamRetryDelay = originalRetryDelay;
			stalledSocket?.destroy();
			upstream.closeAllConnections?.();
			await new Promise((resolve) => upstream.close(resolve));
			await new Promise((resolve) => server.http.close(resolve));
		}
	});

	test('resumes a truncated audio stream with a range request', async () => {
		const payload = Buffer.from(
			Array.from({ length: 100 }, (_, index) => index)
		);
		const requests = [];
		const upstream = http.createServer((req, res) => {
			requests.push(req.headers);
			if (requests.length === 1) {
				res.writeHead(200, {
					'content-type': 'audio/mpeg',
					'content-length': payload.length,
				});
				res.write(payload.subarray(0, 40), () => res.destroy());
				return;
			}
			res.writeHead(206, {
				'content-type': 'audio/mpeg',
				'content-length': payload.length - 40,
				'content-range': `bytes 40-${payload.length - 1}/${
					payload.length
				}`,
			});
			res.end(payload.subarray(40));
		});
		await new Promise((resolve) =>
			upstream.listen(0, '127.0.0.1', resolve)
		);
		await new Promise((resolve) =>
			server.http.listen(0, '127.0.0.1', resolve)
		);

		global.proxy = null;
		global.hosts = {};
		const originalRetryDelay = server.mediaStreamRetryDelay;
		server.mediaStreamRetryDelay = 10;
		const source = `http://127.0.0.1:${upstream.address().port}/song.mp3`;
		const encoded = crypto.base64.encode(source);
		const url = `http://music.163.com/package/${encoded}/1.mp3`;
		try {
			const body = await new Promise((resolve, reject) => {
				const chunks = [];
				const req = http.get(
					{
						hostname: '127.0.0.1',
						port: server.http.address().port,
						path: new URL(url).pathname,
						headers: { host: 'music.163.com' },
					},
					(res) => {
						res.on('data', (chunk) => chunks.push(chunk));
						res.once('end', () => resolve(Buffer.concat(chunks)));
						res.once('error', reject);
					}
				);
				req.once('error', reject);
				req.setTimeout(2000, () =>
					reject(new Error('client remained open'))
				);
			});

			expect(body).toEqual(payload);
			expect(requests).toHaveLength(2);
			expect(requests[1].range).toBe(`bytes=40-${payload.length - 1}`);
		} finally {
			server.mediaStreamRetryDelay = originalRetryDelay;
			upstream.closeAllConnections?.();
			await new Promise((resolve) => upstream.close(resolve));
			await new Promise((resolve) => server.http.close(resolve));
		}
	});

	test('reconnects when upstream throughput stays too low', async () => {
		const payload = Buffer.from(
			Array.from({ length: 10000 }, (_, index) => index % 256)
		);
		const requests = [];
		const upstream = http.createServer((req, res) => {
			requests.push(req.headers);
			if (requests.length === 1) {
				let offset = 0;
				const timer = setInterval(() => {
					const chunk = payload.subarray(offset, offset + 10);
					offset += chunk.length;
					if (chunk.length) res.write(chunk);
					if (offset >= payload.length) clearInterval(timer);
				}, 20);
				res.once('close', () => clearInterval(timer));
				res.writeHead(200, {
					'content-type': 'audio/mpeg',
					'content-length': payload.length,
				});
				return;
			}
			const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)[1]);
			res.writeHead(206, {
				'content-type': 'audio/mpeg',
				'content-length': payload.length - start,
				'content-range': `bytes ${start}-${payload.length - 1}/${
					payload.length
				}`,
			});
			res.end(payload.subarray(start));
		});
		await new Promise((resolve) =>
			upstream.listen(0, '127.0.0.1', resolve)
		);
		await new Promise((resolve) =>
			server.http.listen(0, '127.0.0.1', resolve)
		);

		global.proxy = null;
		global.hosts = {};
		const originalWatchdogInterval = server.mediaStreamWatchdogInterval;
		const originalThroughputWindow = server.mediaStreamThroughputWindow;
		const originalMinThroughput = server.mediaStreamMinThroughput;
		const originalRetryDelay = server.mediaStreamRetryDelay;
		server.mediaStreamWatchdogInterval = 20;
		server.mediaStreamThroughputWindow = 100;
		server.mediaStreamMinThroughput = 1024 * 1024;
		server.mediaStreamRetryDelay = 10;
		const source = `http://127.0.0.1:${upstream.address().port}/song.mp3`;
		const encoded = crypto.base64.encode(source);
		const url = `http://music.163.com/package/${encoded}/1.mp3`;
		try {
			const body = await new Promise((resolve, reject) => {
				const chunks = [];
				const req = http.get(
					{
						hostname: '127.0.0.1',
						port: server.http.address().port,
						path: new URL(url).pathname,
						headers: { host: 'music.163.com' },
					},
					(res) => {
						res.on('data', (chunk) => chunks.push(chunk));
						res.once('end', () => resolve(Buffer.concat(chunks)));
						res.once('error', reject);
					}
				);
				req.once('error', reject);
				req.setTimeout(2000, () =>
					reject(new Error('client remained open'))
				);
			});

			expect(body).toEqual(payload);
			expect(requests).toHaveLength(2);
			expect(requests[1].range).toMatch(/^bytes=\d+-9999$/);
		} finally {
			server.mediaStreamWatchdogInterval = originalWatchdogInterval;
			server.mediaStreamThroughputWindow = originalThroughputWindow;
			server.mediaStreamMinThroughput = originalMinThroughput;
			server.mediaStreamRetryDelay = originalRetryDelay;
			upstream.closeAllConnections?.();
			await new Promise((resolve) => upstream.close(resolve));
			await new Promise((resolve) => server.http.close(resolve));
		}
	});
});
