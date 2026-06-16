const { MongoClient, ServerApiVersion } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client;
let db;

async function connect() {
  if (db) return db;
  client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });
  await client.connect();
  db = client.db('offlinepay');
  return db;
}

module.exports = {
  async getUserById(id) {
    const d = await connect();
    return d.collection('users').findOne({ id });
  },
  async getUserByEmail(email) {
    const d = await connect();
    return d.collection('users').findOne({ email });
  },
  async createUser(user) {
    const d = await connect();
    await d.collection('users').insertOne(user);
    return user;
  },
  async updateUser(id, patch) {
    const d = await connect();
    await d.collection('users').updateOne({ id }, { $set: patch });
    return this.getUserById(id);
  },
  async getTransaction(id) {
    const d = await connect();
    return d.collection('transactions').findOne({ id });
  },
  async upsertTransaction(tx) {
    const d = await connect();
    await d.collection('transactions').updateOne(
      { id: tx.id },
      { $set: tx },
      { upsert: true }
    );
    return this.getTransaction(tx.id);
  },
  async getTransactionsForUser(userId) {
    const d = await connect();
    return d.collection('transactions')
      .find({ $or: [{ senderId: userId }, { receiverId: userId }] })
      .toArray();
  },
  async getPendingOutgoing(userId) {
    const d = await connect();
    return d.collection('transactions')
      .find({ senderId: userId, status: 'pending' })
      .sort({ timestamp: 1 })
      .toArray();
  }
};