/**
 * Cấu hình Firebase — dán thông tin lấy từ Firebase Console vào đây.
 * (Firebase Console -> Project Settings -> General -> Your apps -> SDK setup and configuration)
 *
 * Các giá trị này KHÔNG phải bí mật (không phải mật khẩu/API secret thật) —
 * Firebase công khai thiết kế để nhúng trực tiếp vào code frontend như thế
 * này. An toàn thực sự đến từ "Firestore Security Rules" (cấu hình riêng
 * trên Firebase Console), không phải từ việc giấu các giá trị bên dưới.
 */
const firebaseConfig = {
    apiKey: "AIzaSyBtAq0pjEhTOTwFFsws_mb7WXu9-3Kuyao",
    authDomain: "khanz094-audio-space.firebaseapp.com",
    projectId: "khanz094-audio-space",
    storageBucket: "khanz094-audio-space.firebasestorage.app",
    messagingSenderId: "270349223758",
    appId: "1:270349223758:web:764dd48370b0b4068f401f"
};

// Cờ để script.js biết chắc bạn đã dán config thật hay còn để mặc định —
// tránh lỗi Firebase khó hiểu (script.js sẽ tự tắt tính năng liên quan nếu false).
window.FIREBASE_CONFIGURED = !String(firebaseConfig.apiKey).includes('DÁN_');

let fbAuth, fbDb;
if (window.FIREBASE_CONFIGURED) {
    firebase.initializeApp(firebaseConfig);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
}
