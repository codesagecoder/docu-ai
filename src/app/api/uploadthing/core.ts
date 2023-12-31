import { PLANS } from "@/config/stripe";
import { db } from "@/db";
import { getPineconeClient } from "@/lib/pinecone";
import { getUserSubscriptionPlan } from "@/lib/stripe";
import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { PDFLoader } from 'langchain/document_loaders/fs/pdf';
import { OpenAIEmbeddings } from 'langchain/embeddings/openai';
import { PineconeStore } from 'langchain/vectorstores/pinecone';
import { createUploadthing, type FileRouter } from "uploadthing/next";

const f = createUploadthing();

const middleware = async () => {
  const { getUser } = getKindeServerSession();
  const user = getUser();

  if (!user || !user.id) throw new Error("UNAUTHORIZED");

  const subscriptionPlan = await getUserSubscriptionPlan();

  return { userId: user.id, subscriptionPlan };
}

const onUploadComplete = async (
  { file, metadata }: {
    metadata: Awaited<ReturnType<typeof middleware>>;
    file: {
      key: string;
      name: string;
      url: string;
    };
  }) => {

  const isFileExist = await db.file.findFirst({ where: { key: file.key } });
  if (isFileExist) return;

  const createdFile = await db.file.create({
    data: {
      key: file.key,
      name: file.name,
      userId: metadata.userId,
      // url: file.url,
      url: `https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`,
      uploadStatus: 'PROCESSING'
    }
  });

  try {
    const response = await fetch(`https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`);
    const blob = await response.blob();

    const loader = new PDFLoader(blob);

    const pageLevelDocs = await loader.load();

    const pagesAmt = pageLevelDocs.length;

    const { subscriptionPlan: { isSubscribed } } = metadata;

    const isProExceeded = pagesAmt > PLANS.find(plan => plan.name == 'Pro')!.pagesPerPdf;
    const isFreeExceeded = pagesAmt > PLANS.find(plan => plan.name == 'Free')!.pagesPerPdf;

    if ((isSubscribed && isProExceeded) || isFreeExceeded) {
      await db.file.update({
        data: { uploadStatus: 'FAILED' },
        where: { id: createdFile.id }
      })
    }

    const pinecone = await getPineconeClient();
    const pineconeIndex = pinecone.Index('docu-ai');

    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    })

    await PineconeStore.fromDocuments(pageLevelDocs, embeddings, { pineconeIndex, namespace: createdFile.id });

    await db.file.update({ data: { uploadStatus: "SUCCESS" }, where: { id: createdFile.id } });
  } catch (err) {
    await db.file.update({ data: { uploadStatus: "FAILED" }, where: { id: createdFile.id } })
  }
}

export const ourFileRouter = {
  freePlanUploader: f({ pdf: { maxFileSize: "4MB" } }).middleware(middleware).onUploadComplete(onUploadComplete),
  proPlanUploader: f({ pdf: { maxFileSize: "16MB" } }).middleware(middleware).onUploadComplete(onUploadComplete),

} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;