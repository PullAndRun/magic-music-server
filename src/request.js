const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { ON_CANCEL } = require('./cancel');
const RequestCancelled = require('./exceptions/RequestCancelled');
const { logScope } = require('./logger');

const logger = logScope('request');
const timeoutThreshold = 10 * 1000;
const maxRedirects = 10;
const translate = (host) => (global.hosts || {})[host] || host;
const getPath = (url) =>
	url.path || `${url.pathname || '/'}${url.search || ''}`;
const formatUrl = (url) => url.href || url.toString();
const create = (url, proxy) =>
	(((typeof proxy === 'undefined' ? global.proxy : proxy) || url).protocol ===
	'https:'
		? https
		: http
	).request;

const configure = (method, url, headers, proxy) => {
	headers = { ...(headers || {}) };
	proxy = typeof proxy === 'undefined' ? global.proxy : proxy;
	if ('content-length' in headers) delete headers['content-length'];

	const options = {};
	options._headers = headers;
	if (proxy && url.protocol === 'https:') {
		options.method = 'CONNECT';
		options.headers = Object.keys(headers).reduce(
			(result, key) =>
				Object.assign(
					result,
					['host', 'user-agent'].includes(key) && {
						[key]: headers[key],
					}
				),
			{}
		);
	} else {
		options.method = method;
		options.headers = headers;
	}

	if (proxy) {
		options.hostname = translate(proxy.hostname);
		options.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
		options.path =
			url.protocol === 'https:'
				? translate(url.hostname) + ':' + (url.port || 443)
				: 'http://' +
					translate(url.hostname) +
					(url.port ? `:${url.port}` : '') +
					getPath(url);
	} else {
		options.hostname = translate(url.hostname).replace(/^\[|\]$/g, '');
		options.port = url.port || (url.protocol === 'https:' ? 443 : 80);
		options.path = getPath(url);
	}
	return options;
};

/**
 * @typedef {((raw: true) => Promise<Buffer>) | ((raw: false) => Promise<string>)} RequestExtensionBody
 */

/**
 * @template T
 * @typedef {{url: URL, body: RequestExtensionBody, json: () => Promise<T>, jsonp: () => Promise<T>}} RequestExtension
 */

/**
 * @template T
 * @param {string} method
 * @param {string} receivedUrl
 * @param {Object?} receivedHeaders
 * @param {unknown?} body
 * @param {unknown?} proxy
 * @param {CancelRequest?} cancelRequest
 * @param {number} redirectCount
 * @return {Promise<http.IncomingMessage & RequestExtension<T>>}
 */
const request = (
	method,
	receivedUrl,
	receivedHeaders,
	body,
	proxy,
	cancelRequest,
	redirectCount = 0
) => {
	const url = new URL(receivedUrl);
	if (cancelRequest?.cancelled)
		return Promise.reject(new RequestCancelled(url.href));
	/* @type {Partial<Record<string,string>>} */
	const headers = { ...(receivedHeaders || {}) };
	const options = configure(
		method,
		url,
		{
			host: url.host,
			accept: 'application/json, text/plain, */*',
			'accept-encoding': 'gzip, deflate',
			'accept-language': 'zh-CN,zh;q=0.9',
			'user-agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
			...headers,
		},
		proxy
	);

	return new Promise((resolve, reject) => {
		logger.debug(`Start requesting ${receivedUrl}`);

		let activeRequest = create(url, proxy)(options);
		let activeResponse;
		const cleanup = () =>
			cancelRequest?.removeListener(ON_CANCEL, destroyClientRequest);
		const finish = (handler) => (value) => {
			cleanup();
			handler(value);
		};
		const destroyClientRequest = function () {
			const error = new RequestCancelled(formatUrl(url));
			activeResponse?.destroy(error);
			activeRequest.destroy(error);
		};
		const receiveResponse = (response) => {
			activeResponse = response;
			response.once('end', cleanup);
			response.once('close', cleanup);
			response.once('error', cleanup);
			resolve(response);
		};

		cancelRequest?.once(ON_CANCEL, destroyClientRequest);
		if (cancelRequest?.cancelled ?? false) destroyClientRequest();

		activeRequest
			.setTimeout(timeoutThreshold, () => {
				logger.warn(
					{
						url: formatUrl(url),
					},
					`The request timed out, or the requester didn't handle the response.`
				);
				const error = new Error(`Request timed out: ${formatUrl(url)}`);
				error.code = 'ETIMEDOUT';
				activeRequest.destroy(error);
			})
			.on('response', receiveResponse)
			.on('connect', (response, socket) => {
				if (response.statusCode !== 200) {
					socket.destroy();
					const error = new Error(
						`Proxy CONNECT failed: ${response.statusCode}`
					);
					error.code = 'ERR_PROXY_CONNECT';
					finish(reject)(error);
					return;
				}
				logger.debug(
					'received CONNECT, continuing with https.request()...'
				);
				activeRequest = https
					.request({
						hostname: url.hostname.replace(/^\[|\]$/g, ''),
						port: url.port || 443,
						method: method,
						path: getPath(url),
						headers: options._headers,
						socket: socket,
						agent: false,
					})
					.setTimeout(timeoutThreshold, () => {
						const error = new Error(
							`Request timed out: ${formatUrl(url)}`
						);
						error.code = 'ETIMEDOUT';
						activeRequest.destroy(error);
					})
					.on('response', receiveResponse)
					.on('error', finish(reject))
					.end(body);
			})
			.on('error', finish(reject))
			.end(options.method.toUpperCase() === 'CONNECT' ? undefined : body);
	}).then(
		/** @param {http.IncomingMessage} response */
		(response) => {
			if (cancelRequest?.cancelled ?? false) {
				response.destroy();
				return Promise.reject(new RequestCancelled(formatUrl(url)));
			}

			if (
				[301, 302, 303, 307, 308].includes(response.statusCode) &&
				response.headers.location
			) {
				response.resume();
				if (redirectCount >= maxRedirects) {
					const error = new Error(
						`Too many redirects while requesting ${formatUrl(url)}`
					);
					error.code = 'ERR_TOO_MANY_REDIRECTS';
					return Promise.reject(error);
				}
				const redirectTo = new URL(response.headers.location, url).href;

				logger.debug(`Redirect to ${redirectTo}`);
				delete headers.host;
				return request(
					method,
					redirectTo,
					headers,
					body,
					proxy,
					cancelRequest,
					redirectCount + 1
				);
			}

			return Object.assign(response, {
				url,
				body: (raw) => read(response, raw),
				json: () => json(response),
				jsonp: () => jsonp(response),
			});
		}
	);
};

const read = (connect, raw) =>
	new Promise((resolve, reject) => {
		if (connect.destroyed && !connect.readableEnded) {
			reject(
				connect.errored || new Error('Response stream was destroyed')
			);
			return;
		}
		const chunks = [];
		connect
			.on('data', (chunk) => chunks.push(chunk))
			.on('end', () => resolve(Buffer.concat(chunks)))
			.on('error', (error) => reject(error));
	}).then((buffer) => {
		if (buffer.length) {
			switch (connect.headers['content-encoding']) {
				case 'deflate':
				case 'gzip':
					buffer = zlib.unzipSync(buffer);
					break;
				case 'br':
					buffer = zlib.brotliDecompressSync(buffer);
					break;
			}
		}
		return raw ? buffer : buffer.toString();
	});

const json = (connect) => read(connect, false).then((body) => JSON.parse(body));
const jsonp = (connect) =>
	read(connect, false).then((body) =>
		JSON.parse(body.slice(body.indexOf('(') + 1, -')'.length))
	);

request.read = read;
request.create = create;
request.translate = translate;
request.configure = configure;

module.exports = request;
