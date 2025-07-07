/*
  Warnings:

  - You are about to alter the column `email` on the `Account` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `token_type` on the `Account` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(50)`.
  - You are about to alter the column `session_state` on the `Account` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(255)`.
  - You are about to alter the column `syncStatus` on the `Account` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(50)`.
  - Changed the type of `type` on the `Account` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('oauth', 'email', 'credentials');

-- DropIndex
DROP INDEX "Account_email_key";

-- AlterTable
ALTER TABLE "Account" DROP COLUMN "type",
ADD COLUMN     "type" "ProviderType" NOT NULL,
ALTER COLUMN "email" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "token_type" SET DATA TYPE VARCHAR(50),
ALTER COLUMN "session_state" SET DATA TYPE VARCHAR(255),
ALTER COLUMN "syncStatus" SET DATA TYPE VARCHAR(50);
