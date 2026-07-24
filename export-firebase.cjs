const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://laundry-pos-c7e67.firebaseio.com"
});

const db = admin.firestore();

async function exportData() {
  console.log('🔄 جاري استخراج البيانات من Firebase...');
  
  const data = {};
  
  try {
    const collections = await db.listCollections();
    
    for (const collection of collections) {
      console.log(`📥 استخراج ${collection.id}...`);
      const snapshot = await collection.get();
      data[collection.id] = {};
      
      for (const doc of snapshot.docs) {
        data[collection.id][doc.id] = doc.data();
      }
    }
    
    fs.writeFileSync('firestore-backup.json', JSON.stringify(data, null, 2));
    console.log('✅ تم حفظ البيانات في firestore-backup.json');
    process.exit(0);
  } catch (error) {
    console.error('❌ خطأ:', error);
    process.exit(1);
  }
}

exportData();