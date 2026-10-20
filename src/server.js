const fs = require('fs');
const net = require('net');
const path = require('path');
const parse = require('url').parse;

const { logScope } = require('./logger');
const logger = logScope('server');
const sni = require('./sni');
const hook = require('./hook');
const request = require('./request');
const { isHost } = require('./utilities');

const MEDIA_CONTENT_TYPE = /^(audio|video)\//i;
const MEDIA_EXTENSION =
	/\.(aac|flac|m4a|mp3|ogg|opus|wav|m4s|mp4|webm)(?:$|\?)/i;

const parseContentLength = (value) => {
	const length = Number(value);
	return Number.isSafeInteger(length) && length >= 0 ? length : null;
};

const parseByteRange = (value) => {
	const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || '').trim());
	if (!match) return null;
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : null;
	if (
		!Number.isSafeInteger(start) ||
		(end !== null && (!Number.isSafeInteger(end) || end < start))
	)
		return null;
	return { start, end };
};

const parseContentRange = (value) => {
	const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
		String(value || '').trim()
	);
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = match[3] === '*' ? null : Number(match[3]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		end < start
	)
		return null;
	return { start, end, total };
};

const describeMediaUrl = (value) => {
	try {
		const url = new URL(value);
		return `${url.host}${url.pathname}`;
	} catch {
		return 'audio stream';
	}
};

const proxy = {
	core: {
		mitm: (req, res) => {
			if (req.url === '/proxy.pac') {
				const url = parse('http://' + req.headers.host);
				res.writeHead(200, {
					'Content-Type': 'application/x-ns-proxy-autoconfig',
				});
				res.end(`
					function FindProxyForURL(url, host) {
						if (${Array.from(hook.target.host)
							.map((host) => `host == '${host}'`)
							.join(' || ')}) {
							return 'PROXY ${url.hostname}:${url.port || 80}'
						}
						return 'DIRECT'
					}
				`);
			} else {
				const ctx = { res, req };
				Promise.resolve()
					.then(() => proxy.protect(ctx))
					.then(() => proxy.authenticate(ctx))
					.then(() => hook.request.before(ctx))
					.then(() => proxy.filter(ctx))
					.then(() => proxy.log(ctx))
					.then(() => proxy.mitm.request(ctx))
					.then(() => hook.request.after(ctx))
					.then(() => proxy.mitm.response(ctx))
					.catch((error) => {
						logger.debug(
							{ err: error, url: describeMediaUrl(req.url) },
							'MITM request failed.'
						);
						proxy.mitm.close(ctx);
					});
			}
		},
		tunnel: (req, socket, head) => {
			const ctx = { req, socket, head };
			Promise.resolve()
				.then(() => proxy.protect(ctx))
				.then(() => proxy.authenticate(ctx))
				.then(() => hook.connect.before(ctx))
				.then(() => proxy.filter(ctx))
				.then(() => proxy.log(ctx))
				.then(() => proxy.tunnel.connect(ctx))
				.then(() => proxy.tunnel.dock(ctx))
				.then(() => hook.negotiate.before(ctx))
				.then(() => proxy.tunnel.pipe(ctx))
				.catch(() => proxy.tunnel.close(ctx));
		},
	},
	abort: (socket) => {
		if (socket) socket.end();
		if (socket && !socket.destroyed) socket.destroy();
	},
	protect: (ctx) => {
		const { req, res, socket } = ctx;
		if (req) req.on('error', () => proxy.abort(req.socket, 'req'));
		if (res) res.on('error', () => proxy.abort(res.socket, 'res'));
		if (socket) socket.on('error', () => proxy.abort(socket, 'socket'));
	},
	log: (ctx) => {
		const { req, socket, decision } = ctx;
		if (socket)
			if (socket) logger.debug({ decision, url: req.url }, `TUNNEL`);
			else
				logger.debug(
					{
						decision,
						host: parse(req.url).host,
						encrypted: req.socket.encrypted,
					},
					`MITM${req.socket.encrypted ? ' (ssl)' : ''}`
				);
	},
	authenticate: (ctx) => {
		const { req, res, socket } = ctx;
		const credential = Buffer.from(
			(req.headers['proxy-authorization'] || '').split(/\s+/).pop() || '',
			'base64'
		).toString();
		if ('proxy-authorization' in req.headers)
			delete req.headers['proxy-authorization'];
		if (
			server.authentication &&
			credential !== server.authentication &&
			(socket || req.url.startsWith('http://'))
		) {
			if (socket)
				socket.write(
					'HTTP/1.1 407 Proxy Auth Required\r\nProxy-Authenticate: Basic realm="realm"\r\n\r\n'
				);
			else
				res.writeHead(407, {
					'proxy-authenticate': 'Basic realm="realm"',
				});
			return Promise.reject((ctx.error = 'authenticate'));
		}
	},
	filter: (ctx) => {
		if (ctx.decision || ctx.req.local) return;
		const url = parse((ctx.socket ? 'https://' : '') + ctx.req.url);
		const match = (pattern) =>
			url.href.search(new RegExp(pattern, 'g')) !== -1;
		try {
			const allow = server.whitelist.some(match);
			const deny = server.blacklist.some(match);
			// console.log('allow', allow, 'deny', deny)
			if (!allow && deny) {
				return Promise.reject((ctx.error = 'filter'));
			}
		} catch (error) {
			ctx.error = error;
		}
	},
	mitm: {
		request: (ctx) =>
			new Promise((resolve, reject) => {
				if (ctx.decision === 'close')
					return reject((ctx.error = ctx.decision));
				const { req } = ctx;
				if (isHost(req.url, 'bilivideo.com')) {
					req.headers['referer'] = 'https://www.bilibili.com/';
					req.headers['user-agent'] = 'okhttp/3.4.1';
				}
				const url = parse(req.url);
				const options = request.configure(req.method, url, req.headers);
				ctx.proxyReq = request
					.create(url)(options)
					.on('response', (proxyRes) =>
						resolve((ctx.proxyRes = proxyRes))
					)
					.on('error', (error) => reject((ctx.error = error)));
				req.readable
					? req.pipe(ctx.proxyReq)
					: ctx.proxyReq.end(req.body);
			}),
		response: (ctx) => {
			const { res, proxyRes } = ctx;
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			if (proxyRes.readable && proxy.mitm.pipeMediaStream(ctx)) return;

			const closeSockets = () => {
				// A truncated upstream response must not leave the client waiting
				// forever for the remaining audio bytes.
				proxy.abort(proxyRes.socket, 'proxyRes');
				proxy.abort(res.socket, 'res');
			};
			proxyRes.on('error', closeSockets);
			proxyRes.on('aborted', closeSockets);
			proxyRes.on('close', () => {
				if (!proxyRes.readableEnded) closeSockets();
			});
			res.on('close', () => {
				if (!res.writableEnded) proxy.abort(proxyRes.socket, 'res');
			});
			proxyRes.readable ? proxyRes.pipe(res) : res.end(proxyRes.body);
		},
		// Some CDN connections stay open after a partial media body. Resume
		// from the last received byte rather than making the user seek.
		pipeMediaStream: (ctx) => {
			const { req, res, proxyRes: firstResponse } = ctx;
			const contentType = String(
				firstResponse.headers['content-type'] || ''
			);
			const requestRange = req.headers.range
				? parseByteRange(req.headers.range)
				: null;
			if (
				req.method !== 'GET' ||
				(req.headers.range && !requestRange) ||
				(!MEDIA_CONTENT_TYPE.test(contentType) &&
					!ctx.package &&
					!MEDIA_EXTENSION.test(req.url))
			)
				return false;

			const firstContentRange = parseContentRange(
				firstResponse.headers['content-range']
			);
			const firstLength = parseContentLength(
				firstResponse.headers['content-length']
			);
			const streamStart =
				firstResponse.statusCode === 200
					? 0
					: (firstContentRange?.start ?? requestRange?.start ?? 0);
			const streamEnd =
				firstContentRange?.end ??
				requestRange?.end ??
				(firstLength !== null ? streamStart + firstLength - 1 : null);
			const expectedBytes = firstLength;
			let receivedBytes = 0;
			let retries = 0;
			let finished = false;
			let idleTimer = null;
			let currentAttempt = null;

			const clearIdleTimer = () => {
				if (idleTimer) clearInterval(idleTimer);
				idleTimer = null;
			};
			const destroyCurrentAttempt = () => {
				const response = currentAttempt?.response;
				if (response && !response.destroyed) response.destroy();
			};
			const finish = () => {
				if (finished) return;
				finished = true;
				clearIdleTimer();
				if (!res.writableEnded) res.end();
			};
			const fail = (reason) => {
				if (finished) return;
				finished = true;
				clearIdleTimer();
				logger.error(
					{
						url: describeMediaUrl(req.url),
						receivedBytes,
						retries,
						reason,
					},
					'Media stream recovery failed.'
				);
				destroyCurrentAttempt();
				proxy.abort(res.socket, 'res');
			};
			const attachAttempt = (response) => {
				const startedAt = Date.now();
				const attempt = {
					response,
					settled: false,
					lastProgressAt: startedAt,
					windowStartedAt: startedAt,
					windowStartBytes: receivedBytes,
					paused: false,
				};
				currentAttempt = attempt;
				const attemptFailed = (reason) => {
					if (finished || attempt.settled) return;
					attempt.settled = true;
					clearIdleTimer();
					response.destroy();
					retry(reason);
				};
				const armIdleTimer = () => {
					clearIdleTimer();
					idleTimer = setInterval(() => {
						if (finished || attempt.settled) return;
						if (attempt.paused) return;
						const now = Date.now();
						const idleFor = now - attempt.lastProgressAt;
						if (idleFor >= server.mediaStreamIdleTimeout) {
							attemptFailed('upstream idle timeout');
							return;
						}
						const windowElapsed = now - attempt.windowStartedAt;
						if (
							windowElapsed >= server.mediaStreamThroughputWindow
						) {
							const windowBytes =
								receivedBytes - attempt.windowStartBytes;
							const requiredBytes =
								server.mediaStreamMinThroughput *
								(windowElapsed / 1000);
							if (windowBytes < requiredBytes) {
								const kbps = Math.round(
									windowBytes / (windowElapsed / 1000) / 1024
								);
								attemptFailed(
									`upstream throughput too low (${kbps} KiB/s)`
								);
								return;
							}
							attempt.windowStartedAt = now;
							attempt.windowStartBytes = receivedBytes;
						}
					}, server.mediaStreamWatchdogInterval);
					idleTimer.unref?.();
				};
				response.on('data', (chunk) => {
					if (finished || attempt.settled) return;
					if (expectedBytes !== null) {
						const remaining = expectedBytes - receivedBytes;
						if (remaining <= 0) {
							attempt.settled = true;
							clearIdleTimer();
							response.destroy();
							finish();
							return;
						}
						if (chunk.length > remaining)
							chunk = chunk.subarray(0, remaining);
					}
					receivedBytes += chunk.length;
					attempt.lastProgressAt = Date.now();
					if (!res.write(chunk)) {
						response.pause();
						attempt.paused = true;
						res.once('drain', () => {
							if (!finished && !attempt.settled) {
								attempt.paused = false;
								attempt.lastProgressAt = Date.now();
								attempt.windowStartedAt = Date.now();
								attempt.windowStartBytes = receivedBytes;
								response.resume();
							}
						});
					}
					if (
						expectedBytes !== null &&
						receivedBytes >= expectedBytes
					) {
						attempt.settled = true;
						clearIdleTimer();
						response.destroy();
						finish();
					}
				});
				response.once('end', () => {
					if (finished || attempt.settled) return;
					attempt.settled = true;
					clearIdleTimer();
					if (
						expectedBytes !== null &&
						receivedBytes < expectedBytes
					) {
						retry('upstream ended before content-length');
					} else {
						finish();
					}
				});
				response.once('error', (error) =>
					attemptFailed(error?.message || 'upstream response error')
				);
				response.once('aborted', () =>
					attemptFailed('upstream response aborted')
				);
				response.once('close', () => {
					if (!response.readableEnded)
						attemptFailed('upstream response closed early');
				});
				armIdleTimer();
			};
			// Continue the existing downstream response with a new byte range.
			const retry = (reason) => {
				if (finished) return;
				clearIdleTimer();
				if (retries >= server.mediaStreamMaxRetries) {
					fail(reason);
					return;
				}
				retries++;
				const nextStart = streamStart + receivedBytes;
				const url = describeMediaUrl(req.url);
				logger.warn(
					{
						url,
						nextStart,
						receivedBytes,
						retries,
						reason,
					},
					'Media stream stalled; reconnecting from the next byte.'
				);
				const headers = {
					...req.headers,
					'accept-encoding': 'identity',
				};
				delete headers['proxy-authorization'];
				delete headers['content-length'];
				if (nextStart > 0 || req.headers.range) {
					headers.range = `bytes=${nextStart}-${
						streamEnd === null ? '' : streamEnd
					}`;
				} else {
					delete headers.range;
				}
				setTimeout(() => {
					if (finished) return;
					request(req.method, req.url, headers)
						.then((response) => {
							if (finished) {
								response.destroy();
								return;
							}
							const contentRange = parseContentRange(
								response.headers['content-range']
							);
							if (
								response.statusCode >= 300 &&
								response.statusCode < 400
							) {
								response.destroy();
								retry(`HTTP ${response.statusCode}`);
								return;
							}
							if (nextStart > 0 && response.statusCode !== 206) {
								response.destroy();
								fail(
									`upstream ignored Range with HTTP ${response.statusCode}`
								);
								return;
							}
							if (
								nextStart > 0 &&
								contentRange &&
								contentRange.start !== nextStart
							) {
								response.destroy();
								fail(
									`upstream resumed at ${contentRange.start} instead of ${nextStart}`
								);
								return;
							}
							attachAttempt(response);
						})
						.catch((error) => {
							if (finished) return;
							logger.warn(
								{
									url,
									retries,
									err: error?.message || String(error),
								},
								'Media stream reconnect failed.'
							);
							retry('reconnect failed');
						});
				}, server.mediaStreamRetryDelay);
			};

			res.on('error', () => {
				finished = true;
				clearIdleTimer();
				destroyCurrentAttempt();
			});
			res.on('close', () => {
				if (!res.writableEnded) {
					finished = true;
					clearIdleTimer();
					destroyCurrentAttempt();
					proxy.abort(currentAttempt?.response?.socket, 'res');
				}
			});
			attachAttempt(firstResponse);
			return true;
		},
		close: (ctx) => {
			proxy.abort(ctx.res.socket, 'mitm');
		},
	},
	tunnel: {
		connect: (ctx) =>
			new Promise((resolve, reject) => {
				if (ctx.decision === 'close')
					return reject((ctx.error = ctx.decision));
				const { req } = ctx;
				const url = parse('https://' + req.url);
				if (global.proxy && !req.local) {
					const options = request.configure(
						req.method,
						url,
						req.headers
					);
					request
						.create(proxy)(options)
						.on('connect', (_, proxySocket) =>
							resolve((ctx.proxySocket = proxySocket))
						)
						.on('error', (error) => reject((ctx.error = error)))
						.end();
				} else {
					const proxySocket = net
						.connect(
							url.port || 443,
							request.translate(url.hostname)
						)
						.on('connect', () =>
							resolve((ctx.proxySocket = proxySocket))
						)
						.on('error', (error) => reject((ctx.error = error)));
				}
			}),
		dock: (ctx) =>
			new Promise((resolve) => {
				const { req, head, socket } = ctx;
				socket
					.once('data', (data) =>
						resolve((ctx.head = Buffer.concat([head, data])))
					)
					.write(
						`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`
					);
			})
				.then((data) => (ctx.socket.sni = sni(data)))
				.catch((e) => e && logger.error(e)),
		pipe: (ctx) => {
			if (ctx.decision === 'blank')
				return Promise.reject((ctx.error = ctx.decision));
			const { head, socket, proxySocket } = ctx;
			proxySocket.on('error', () =>
				proxy.abort(ctx.proxySocket, 'proxySocket')
			);
			proxySocket.write(head);
			socket.pipe(proxySocket);
			proxySocket.pipe(socket);
		},
		close: (ctx) => {
			proxy.abort(ctx.socket, 'tunnel');
		},
	},
};

const cert = process.env.SIGN_CERT || path.join(__dirname, '..', 'server.crt');
const key = process.env.SIGN_KEY || path.join(__dirname, '..', 'server.key');
const options = {
	key: fs.readFileSync(key),
	cert: fs.readFileSync(cert),
};

const server = {
	http: require('http')
		.createServer()
		.on('request', proxy.core.mitm)
		.on('connect', proxy.core.tunnel),
	https: require('https')
		.createServer(options)
		.on('request', proxy.core.mitm)
		.on('connect', proxy.core.tunnel),
};

server.whitelist = [];
server.blacklist = ['://127\\.\\d+\\.\\d+\\.\\d+', '://localhost'];
server.authentication = null;
server.mediaStreamIdleTimeout = 8 * 1000;
server.mediaStreamWatchdogInterval = 500;
server.mediaStreamThroughputWindow = 5 * 1000;
server.mediaStreamMinThroughput = 12 * 1024;
server.mediaStreamMaxRetries = 3;
server.mediaStreamRetryDelay = 100;

module.exports = server;
