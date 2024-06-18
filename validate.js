export function validate() {
  console.log("Run validator");
  try {
    if (!process.env.MESSENGER_EMAIL) {
      throw new Error(
        "Please specify the MESSENGER_EMAIL environment variable"
      );
    } else if (!process.env.MESSENGER_PASSWORD) {
      throw new Error(
        "Please specify the MESSENGER_PASSWORD environment variable"
      );
    } else if (!process.env.MESSENGER_CONVERSATION_URL) {
      throw new Error(
        "Please specify the MESSENGER_CONVERSATION_URL environment variable"
      );
    } else if (!process.env.EREMIZA_LOGIN) {
      throw new Error("Please specify the EREMIZA_LOGIN environment variable");
    } else if (!process.env.EREMIZA_PASSWORD) {
      throw new Error(
        "Please specify the EREMIZA_PASSWORD environment variable"
      );
    } else if (!process.env.GIST_ID) {
      throw new Error("Please specify the GIST_ID environment variable");
    } else if (!process.env.GIST_TOKEN) {
      throw new Error("Please specify the GIST_TOKEN environment variable");
    } else {
      console.log("Environment variables are correctly set");
    }
  } catch (error) {
    console.log(error);
  }
}
