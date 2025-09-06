import fs from 'fs/promises'
import OpenAI from 'openai'
import { Client } from 'discord.js'
import { zodTextFormat } from 'openai/helpers/zod.js'
import z from 'zod'

const client = new OpenAI()
const discord = new Client({
  token: process.env.DISCORD_TOKEN,
  intents: []
})

await discord.login()
const changelog = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID)

await changelog.send(new Date() + ' start creating new version')

const sourceFiles = await fs.readdir('./workspace', { recursive: true })
const sourceFileJobs = sourceFiles.map((sourceFile) => 
  new Promise(async (resolve) => {
    const data = await fs.readFile('./workspace/' + sourceFile, 'utf-8')
    resolve({
      data,
      fileName: sourceFile
    })
  })
)

const sourceFileContents = await Promise.all(sourceFileJobs)
const taskFiles = await fs.readdir('./prompts/tasks', { recursive: true })
const taskFileContents = await Promise.all(taskFiles.map((v) => fs.readFile('./prompts/tasks/' + v, 'utf-8')))

const promptRaw = await fs.readFile('./prompts/main.txt', 'utf-8')
const prompt = promptRaw
  .replace('{{FILES}}', JSON.stringify(sourceFileContents, null, 2))
  .replace('{{TASK}}', taskFileContents[Math.floor(Math.random() * taskFileContents.length)])

const response = await client.responses.parse({
  model: 'gpt-5',
  store: true,
  input: [{
    role: 'user',
    content: prompt
  }],
  reasoning: {
    effort: 'high'
  },
  text: {
    verbosity: 'high',
    format: zodTextFormat(z.object({
      modifyJobs: z.array(z.object({
        file: z.string(),
        type: z.enum(['append', 'replace', 'delete']),
        source: z.string(),
        destination: z.string()
      })),
      commitMessage: z.string(),
      changelog: z.string()
    }), "output")
  }
})

await changelog.send(new Date() + ' finished: ' + source_response.output_text.length + ' characters')
await changelog.send(response.output_parsed.changelog)

for (const job of response.output_parsed.modifyJobs) {
  const file = sourceFileContents.find((v) => v.fileName === job.file)
  if (!file) {
    console.error('file not found', job.file)
    continue
  }

  if (job.type === 'append') {
    file.data = file.data.split('\n').slice(0, parseInt(job.source)-1).join('\n') + '\n' + job.destination + '\n' + file.data.split('\n').slice(parseInt(job.source)-1).join('\n')
  }
  
  if (job.type === 'replace') {
    file.data = file.data.replaceAll(job.source, job.destination)
  }
  
  if (job.type === 'delete') {
    file.data = file.data.split('\n').filter((v, i) => i !== parseInt(job.source)-1).join('\n')
  }

  await fs.writeFile('./workspace/' + job.file, file.data, 'utf-8')
}

console.log('Files written, committing: ' + response.output_parsed.commitMessage)
console.log('Changelog:\n' + response.output_parsed.changelog)

fs.appendFileSync(process.env.GITHUB_OUTPUT, 'COMMIT_MESSAGE='+commit_response.output_text+'\n')
process.exit()
