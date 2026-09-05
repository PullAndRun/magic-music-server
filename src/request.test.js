const http = require('http');
const zlib = require('zlib');
const { CancelRequest, ON_CANCEL } = require('./cancel');
const request = require('./request');
const RequestCancelled = require('./exceptions/RequestCancelled');

describe('request()', () => {
	let server;
	let baseUrl;
	let onSlowRequest;

	beforeAll((done) => {
		server = http.createServer((req, res) => {
			switch (req.url) {
				case '/slow':
					onSlowRequest();
					break;
				case '/redirect-slow':
					res.writeHead(302, { location: '/slow' });
					res.end();
					break;
				case '/stream':
					res.write('partial');
					break;
				case '/json':
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: true }));
					break;
				case '/jsonp':
					res.end('callback({"ok":true})');
					break;
				case '/gzip':
					res.setHeader('content-encoding', 'gzip');
					res.end(zlib.gzipSync('compressed'));
					break;
				case '/redirect':
					res.writeHead(302, { location: '/text' });
					res.end();
					break;
				case '/redirect-loop':
					res.writeHead(302, { location: '/redirect-loop' });
					res.end();
					break;
				case '/created':
					res.writeHead(201, { 'x-test': 'created' });
					res.end('created');
					break;
				default:
					res.setHeader('x-test', 'local');
					res.end('hello');
			}
		});
		server.listen(0, '127.0.0.1', () => {
			baseUrl = `http://127.0.0.1:${server.address().port}`;
			done();
		});
	});

	afterAll((done) => {
		server.close(done);
	});

	test.each(['/slow', '/redirect-slow'])(
		'cancels an in-flight request to %s',
		async (path) => {
			const cancellation = new CancelRequest();
			onSlowRequest = () => cancellation.cancel();
			await expect(
				request(
					'GET',
					baseUrl + path,
					undefined,
					undefined,
					null,
					cancellation
				)
			).rejects.toBeInstanceOf(RequestCancelled);
			expect(cancellation.listenerCount(ON_CANCEL)).toBe(0);
		}
	);

	test('cancels a response body after headers arrive', async () => {
		const cancellation = new CancelRequest();
		const response = await request(
			'GET',
			`${baseUrl}/stream`,
			undefined,
			undefined,
			null,
			cancellation
		);
		const body = response.body();
		cancellation.cancel();
		await expect(body).rejects.toBeInstanceOf(RequestCancelled);
		expect(cancellation.listenerCount(ON_CANCEL)).toBe(0);
	});

	test('removes cancellation listeners after reading a response', async () => {
		const cancellation = new CancelRequest();
		const response = await request(
			'GET',
			`${baseUrl}/text`,
			undefined,
			undefined,
			null,
			cancellation
		);
		await response.body();
		expect(cancellation.listenerCount(ON_CANCEL)).toBe(0);
	});

	test('preserves the target port and query through an HTTP proxy', async () => {
		const options = request.configure(
			'GET',
			new URL('http://example.com:8080/a?q=1'),
			{},
			new URL(baseUrl)
		);
		expect(options.path).toBe('http://example.com:8080/a?q=1');
	});

	test('rejects an already cancelled request', async () => {
		const cancelRequest = new CancelRequest();
		cancelRequest.cancel();

		await expect(
			request(
				'GET',
				`${baseUrl}/text`,
				undefined,
				undefined,
				undefined,
				cancelRequest
			)
		).rejects.toBeInstanceOf(RequestCancelled);
	});

	test('returns headers and exposes the final request URL', async () => {
		const response = await request('GET', `${baseUrl}/text`);

		expect(response.headers['x-test']).toBe('local');
		expect(response.url).toBeInstanceOf(URL);
		expect(response.url.href).toBe(`${baseUrl}/text`);
		await response.body(false);
	});

	test('returns text and raw response bodies', async () => {
		const textResponse = await request('GET', `${baseUrl}/text`);
		const rawResponse = await request('GET', `${baseUrl}/text`);

		expect(await textResponse.body(false)).toBe('hello');
		expect(await rawResponse.body(true)).toEqual(Buffer.from('hello'));
	});

	test('decompresses and deserializes response bodies', async () => {
		const compressedResponse = await request('GET', `${baseUrl}/gzip`);
		const jsonResponse = await request('GET', `${baseUrl}/json`);
		const jsonpResponse = await request('GET', `${baseUrl}/jsonp`);

		expect(await compressedResponse.body(false)).toBe('compressed');
		expect(await jsonResponse.json()).toEqual({ ok: true });
		expect(await jsonpResponse.jsonp()).toEqual({ ok: true });
	});

	test('follows relative redirects', async () => {
		const response = await request('GET', `${baseUrl}/redirect`);

		expect(response.url.href).toBe(`${baseUrl}/text`);
		expect(await response.body(false)).toBe('hello');
	});

	test('does not treat a 201 response as a redirect', async () => {
		const response = await request('POST', `${baseUrl}/created`);

		expect(response.statusCode).toBe(201);
		expect(await response.body(false)).toBe('created');
	});

	test('rejects redirect loops', async () => {
		await expect(
			request('GET', `${baseUrl}/redirect-loop`)
		).rejects.toMatchObject({ code: 'ERR_TOO_MANY_REDIRECTS' });
	});
});
