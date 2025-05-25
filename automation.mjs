import fs from 'fs'
import OpenAI from 'openai'
import { Client } from 'discord.js'

const original_source = fs.readFileSync('./workspace/main.mjs').toString('utf-8')

const changelog_prompt = fs.readFileSync('./proms/changelog_prompt.txt').toString('utf-8')
const commit_prompt = fs.readFileSync('./proms/commit_prompt.txt').toString('utf-8')
const package_prompt = fs.readFileSync('./proms/package_prompt.txt').toString('utf-8')
const source_prompt = fs.readFileSync('./proms/source_prompt.txt').toString('utf-8').replace('{{source}}', original_source)

const client = new OpenAI()
const discord = new Client({
  token: process.env.DISCORD_TOKEN,
  intents: []
})

await discord.login()
const changelog = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID)

await changelog.send(new Date() + ' start creating new version')

const source_response = await client.responses.create({
  model: 'gpt-4.1',
  input: [{
    role: 'user',
    content: source_prompt
  }],
  max_output_tokens: 16384
})

await changelog.send(new Date() + ' finished: ' + source_response.output_text.length + ' characters')

const requested_original = source_response.output_text.split('=======')[0].split('<<<<<<< ORIGINAL')[1].trim()
const requested_updated = source_response.output_text.split('=======')[1].split('>>>>>>> UPDATED')[0].trim()

const modified_source = original_source.replace(requested_original, requested_updated)

fs.writeFileSync('./workspace/main.mjs', modified_source)

const package_response = await client.responses.create({
  model: 'gpt-4.1',
  input: [
    {
      role: 'user',
      content: source_prompt
    },
    {
      role: 'assistant',
      content: source_response.output_text
    },
    {
      role: 'user',
      content: package_prompt
    },
  ]
})

fs.writeFileSync('./workspace/package.json', package_response.output_text)

const changelog_response = await client.responses.create({
  model: 'gpt-4.1',
  input: [
    {
      role: 'user',
      content: source_prompt
    },
    {
      role: 'assistant',
      content: source_response.output_text
    },
    {
      role: 'user',
      content: package_prompt
    },
    {
      role: 'assistant',
      content: package_response.output_text
    },
    {
      role: 'user',
      content: changelog_prompt
    }
  ]
})

await changelog.send(changelog_response.output_text)

const commit_response = await client.responses.create({
  model: 'gpt-4.1',
  input: [
    {
      role: 'user',
      content: source_prompt
    },
    {
      role: 'assistant',
      content: source_response.output_text
    },
    {
      role: 'user',
      content: package_prompt
    },
    {
      role: 'assistant',
      content: package_response.output_text
    },
    {
      role: 'user',
      content: changelog_prompt
    },
    {
      role: 'assistant',
      content: changelog_response.output_text
    },
    {
      role: 'user',
      content: commit_prompt
    }
  ]
})

fs.appendFileSync(process.env.GITHUB_OUTPUT, 'COMMIT_MESSAGE='+commit_response.output_text+'\n')
process.exit()
