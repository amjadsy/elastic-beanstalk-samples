'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createApp } = require('../app');

function createFakeDatabase() {
  let healthy = true;
  let nextId = 2;
  const books = [{
    id: 1,
    title: '<script>alert("escaped")</script>',
    author: 'Test Author',
  }];

  return {
    setHealthy(value) {
      healthy = value;
    },
    async healthCheck() {
      if (!healthy) {
        throw new Error('database unavailable');
      }
    },
    async listBooks(searchTerm) {
      const query = searchTerm.toLowerCase();
      return books.filter((book) =>
        !query ||
        book.title.toLowerCase().includes(query) ||
        book.author.toLowerCase().includes(query));
    },
    async getBook(id) {
      return books.find((book) => book.id === id) || null;
    },
    async createBook(title, author) {
      books.push({ id: nextId++, title, author });
    },
    async updateBook(id, title, author) {
      const book = books.find((candidate) => candidate.id === id);
      if (!book) {
        return false;
      }
      book.title = title;
      book.author = author;
      return true;
    },
    async deleteBook(id) {
      const index = books.findIndex((book) => book.id === id);
      if (index === -1) {
        return false;
      }
      books.splice(index, 1);
      return true;
    },
  };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let database;
let server;
let baseUrl;

before(async () => {
  database = createFakeDatabase();
  const app = createApp({ database, logger, version: 'test' });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('liveness and readiness are independent', async () => {
  assert.equal((await fetch(`${baseUrl}/up`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);

  database.setHealthy(false);
  assert.equal((await fetch(`${baseUrl}/up`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
  database.setHealthy(true);
});

test('renders escaped database values and security headers', async () => {
  const response = await fetch(baseUrl);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(body, /<script>alert/);
  assert.match(body, /&lt;script&gt;alert/);
});

test('validates and creates books', async () => {
  const invalid = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    body: new URLSearchParams({ title: '', author: '' }),
    redirect: 'manual',
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    body: new URLSearchParams({
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
    }),
    redirect: 'manual',
  });
  assert.equal(created.status, 303);

  const page = await (await fetch(baseUrl)).text();
  assert.match(page, /The Left Hand of Darkness/);
});

test('updates and deletes books', async () => {
  const updated = await fetch(`${baseUrl}/books/2`, {
    method: 'POST',
    body: new URLSearchParams({
      title: 'Invisible Cities',
      author: 'Italo Calvino',
    }),
    redirect: 'manual',
  });
  assert.equal(updated.status, 303);

  const deleted = await fetch(`${baseUrl}/books/2/delete`, {
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(deleted.status, 303);
  assert.equal((await fetch(`${baseUrl}/books/2/edit`)).status, 404);
});

test('exposes masked metadata and metrics', async () => {
  const info = await (await fetch(`${baseUrl}/info`)).json();
  assert.equal(info.name, 'bobs-bookstore-node');
  assert.equal(info.version, 'test');
  assert.equal(Object.hasOwn(info, 'database_url'), true);

  const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(metrics, /http_requests_total \d+/);
});

