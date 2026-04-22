/**
 * Extract raw text from a receipt image using a multimodal model.
 *
 * We use @cf/google/gemma-3-12b-it, which is multimodal (text + image) and
 * not gated by a license prompt (unlike Meta's Llama vision models, which
 * require submitting 'agree' and exclude EU users).
 */
export async function extractTextFromImage(
  ai: Ai,
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const response = (await ai.run("@cf/google/gemma-3-12b-it", {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract all text from this receipt image. Include every line of text exactly as it appears. Output only the extracted text, nothing else.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    max_tokens: 2048,
  })) as { response?: string };

  return response.response || "";
}
