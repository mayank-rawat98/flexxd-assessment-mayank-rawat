const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, seed, clock } = require('./index');

// Seed users: u1 has 2 credits, u2 has 0. Seed venues: v1 (capacity 2), v2 (capacity 5).
beforeEach(() => seed());

const book = (userId, venueId) => request(app).post('/bookings').send({ userId, venueId });
const redeem = (code) => request(app).post('/bookings/redeem').send({ code });

test('booking deducts one credit', async () => {
  const res = await book('u1', 'v1');

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'booked');
  assert.match(res.body.redemptionCode, /^[A-Z2-9]{8}$/);

  const user = await request(app).get('/users/u1');
  assert.equal(user.body.credits, 1);
  assert.deepEqual(user.body.bookings.map((b) => b.id), [res.body.id]);
});

test('user with 0 credits gets 409 and no booking is created', async () => {
  const res = await book('u2', 'v1');

  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INSUFFICIENT_CREDITS');

  const user = await request(app).get('/users/u2');
  assert.equal(user.body.credits, 0);
  assert.deepEqual(user.body.bookings, []);
});

test('redeeming the same code twice gets 409 the second time', async () => {
  const { body: booking } = await book('u1', 'v1');

  const first = await redeem(booking.redemptionCode);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'redeemed');
  assert.ok(first.body.redeemedAt);

  const second = await redeem(booking.redemptionCode);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'ALREADY_REDEEMED');
});

test('redeeming a code 10 minutes after booking gets 410', async () => {
  const start = Date.parse('2026-01-01T12:00:00.000Z');
  clock.now = () => start;
  const { body: booking } = await book('u1', 'v1');

  clock.now = () => start + 10 * 60 * 1000;
  const res = await redeem(booking.redemptionCode);

  assert.equal(res.status, 410);
  assert.equal(res.body.error.code, 'CODE_EXPIRED');
});
