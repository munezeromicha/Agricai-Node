export const FARMER_SCANS_PER_DAY = Number(process.env.FARMER_SCANS_PER_DAY) || 10;
export const FARMER_CHATS_PER_DAY = Number(process.env.FARMER_CHATS_PER_DAY) || 10;

export function normalizeRole(role) {
  return role === "superadmin" ? "superadmin" : "farmer";
}

export function roleLimits(user) {
  if (user?.role === "superadmin") {
    return {
      scansPerDay: Infinity,
      chatsPerDay: Infinity,
      pdfExport: true,
      chatbot: true,
      adminAccess: true,
    };
  }
  return {
    scansPerDay: FARMER_SCANS_PER_DAY,
    chatsPerDay: FARMER_CHATS_PER_DAY,
    pdfExport: true,
    chatbot: true,
    adminAccess: false,
  };
}
