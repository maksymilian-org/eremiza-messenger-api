import { Octokit } from "octokit";

const FILE_NAME = "last-alert.json";

export const getData = async () => {
  const octokit = new Octokit({
    auth: process.env.GIST_TOKEN,
  });

  try {
    const gist = await octokit.request(`GET /gists/${process.env.GIST_ID}`, {
      gist_id: "GIST_ID",
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const files = await gist.data.files;
    const fileContent = files[FILE_NAME].content;
    const data = JSON.parse(fileContent || {});
    return data;
  } catch (error) {
    console.log(error);
  }
};

export const setData = async (content) => {
  const octokit = new Octokit({
    auth: process.env.GIST_TOKEN,
  });

  try {
    await octokit.request(`PATCH /gists/${process.env.GIST_ID}`, {
      gist_id: "GIST_ID",
      description: "",
      files: {
        [FILE_NAME]: {
          content,
        },
      },
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    console.log(error);
  }
};

export const setIsChecking = async () => {
  const data = await getData();
  if (!data?.isChecking) {
    await setData(
      JSON.stringify({
        ...(data || {}),
        isChecking: true,
        updated: new Date().toISOString(),
      })
    );
  }
};

export const setAlertData = async (data) => {
  const currentData = await getData();
  await setData(
    JSON.stringify({
      ...(currentData || {}),
      ...data,
      updated: new Date().toISOString(),
    })
  );
};
