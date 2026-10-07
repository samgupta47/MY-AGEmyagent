// All settings for the ITTAN AI agent. Edit here and restart the server.
export default {
  // CRM login (read-only Viewer account is enough) - the agent reads all designs + stock from here
  CRM_BASE_URL: "https://crm.ittanjeweller.com",
  CRM_EMAIL: "sameergpt9719@gmail.com",
  CRM_PASSWORD: "Lt2zv@A!5s&d1",

  // Store WhatsApp number for "Enquire on WhatsApp" buttons (used unless changed in Admin → Settings)
  WHATSAPP_PHONE: "9914905216",

  // Password for the admin panel (/admin). Empty = no login.
  ADMIN_PASSWORD: "Ittan@kgSZH0aF#26",

  // Claude API key (starts with sk-ant-api03-). Empty = free basic mode.
  ANTHROPIC_API_KEY: "",

  // Find similar designs from a customer's photo (needs ~1 GB RAM). Set false to turn off.
  PHOTO_SEARCH: true,

  // Folder for saved data (training, chats, leads, products, photo model).
  // Empty = automatic: project data/ folder on Windows, ~/ittan-agent-data on a server.
  DATA_DIR: "",

  // Port the server listens on (hosting panels may override this automatically).
  PORT: 3000,
};
