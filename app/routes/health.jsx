export const loader = async () =>
  Response.json(
    {
      status: "ok",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
