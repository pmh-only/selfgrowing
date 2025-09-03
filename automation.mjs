import fs from 'fs'
import OpenAI from 'openai'
import { Client } from 'discord.js'

const original_source = fs.readFileSync('./workspace/main.mjs').toString('utf-8')

const changelog_prompt = fs.readFileSync('./proms/changelog_prompt.txt').toString('utf-8')
const commit_prompt = fs.readFileSync('./proms/commit_prompt.txt').toString('utf-8')
const package_prompt = fs.readFileSync('./proms/package_prompt.txt').toString('utf-8')
const error_check_prompt = fs.readFileSync('./proms/error_check_prompt.txt').toString('utf-8')
const syntax_check_prompt = fs.readFileSync('./proms/syntax_check_prompt.txt').toString('utf-8')
const diff_fix_prompt = fs.readFileSync('./proms/diff_fix_prompt.txt').toString('utf-8')
const logical_validation_prompt = fs.readFileSync('./proms/logical_validation_prompt.txt').toString('utf-8')
const user_error_fix_prompt = fs.readFileSync('./proms/user_error_fix_prompt.txt').toString('utf-8')
const source_prompt = fs.readFileSync('./proms/source_prompt.txt').toString('utf-8').replace('{{source}}', original_source)

const client = new OpenAI()
const discord = new Client({
  token: process.env.DISCORD_TOKEN,
  intents: []
})

await discord.login()
const changelog = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID)

// Helper function to safely send Discord messages
async function safeSend(message) {
  try {
    if (typeof message === 'string') {
      let content = message
      if (content.length > 1800) {
        content = content.substring(0, 1800) + '\n...(truncated)'
      }
      await changelog.send(content)
    } else if (typeof message === 'object' && message.content) {
      let content = message.content
      if (content.length > 1800) {
        content = content.substring(0, 1800) + '\n...(truncated)'
      }
      await changelog.send({
        ...message,
        content: content
      })
    } else {
      await changelog.send(message)
    }
  } catch (error) {
    console.error('Discord send error:', error.message)
  }
}

// Error reporting queue management
async function loadUserErrorReports() {
  try {
    const content = fs.readFileSync('./user_error_reports.json', 'utf-8')
    return JSON.parse(content)
  } catch {
    return []
  }
}

async function saveUserErrorReports(reports) {
  fs.writeFileSync('./user_error_reports.json', JSON.stringify(reports, null, 2))
}

async function clearProcessedReports() {
  const reports = await loadUserErrorReports()
  const unprocessed = reports.filter(report => report.status !== 'processed')
  await saveUserErrorReports(unprocessed)
}

// Function to validate critical Discord bot patterns
function validateCriticalPatterns(sourceCode) {
  // Remove comments to avoid false positives
  const cleanCode = sourceCode.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  
  const criticalPatterns = [
    { name: 'client.login()', regex: /(?<!\/\/.*)\bclient\.login\s*\(/g, required: true },
    { name: 'new Client()', regex: /(?<!\/\/.*)\bnew\s+Client\s*\(/g, required: true },
    { name: 'client.on(\'ready\'', regex: /(?<!\/\/.*)\bclient\.on\s*\(\s*['"']ready['"']/g, required: true },
    { name: 'client.on(\'interactionCreate\'', regex: /(?<!\/\/.*)\bclient\.on\s*\(\s*['"']interactionCreate['"']/g, required: true },
    { name: 'process.env.DISCORD_TOKEN', regex: /(?<!\/\/.*)\bprocess\.env\.DISCORD_TOKEN/g, required: true },
    { name: 'database initialization', regex: /(?<!\/\/.*)(await\s+open\(|db\s*=)/g, required: true },
    { name: 'import.*discord.js', regex: /^import.*['"]discord\.js['"]/gm, required: true }
  ]
  
  const missing = []
  const found = []
  
  for (const pattern of criticalPatterns) {
    const matches = cleanCode.match(pattern.regex)
    if (matches && matches.length > 0) {
      found.push(`✅ ${pattern.name}: ${matches.length} occurrence(s)`)
    } else if (pattern.required) {
      missing.push(`❌ Missing: ${pattern.name}`)
    }
  }
  
  return { missing, found, isValid: missing.length === 0 }
}

// Function to parse and apply diff-style patches
function applyDiffPatches(sourceCode, diffOutput) {
  try {
    const lines = sourceCode.split('\n')
    
    // Remove code block markers if present and clean up
    const cleanedDiff = diffOutput
      .replace(/```diff\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/^\s*\n/gm, '') // Remove empty lines at start
    
    const diffBlocks = cleanedDiff.split('@@@ filename:').slice(1)
    
    // Process blocks in reverse order to maintain line numbers
    for (let blockIndex = diffBlocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = diffBlocks[blockIndex]
      const diffLines = block.split('\n')
      let headerFound = false
      let startLine = -1
      let removals = []
      let additions = []
      
      for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i].trim()
        
        // Skip metadata lines
        if (line.startsWith('---') || line.startsWith('+++')) continue
        
        // Find the @@ header with line numbers  
        if (line.startsWith('@@ -')) {
          const match = line.match(/@@ -(\d+),?(\d+)?/)
          if (match) {
            startLine = parseInt(match[1]) - 1 // Convert to 0-based index
            headerFound = true
            removals = []
            additions = []
          }
          continue
        }
        
        if (!headerFound) continue
        
        // Process diff lines (remove leading/trailing spaces for comparison)
        const originalLine = diffLines[i]
        if (originalLine.startsWith('-')) {
          removals.push(originalLine.substring(1))
        } else if (originalLine.startsWith('+')) {
          additions.push(originalLine.substring(1))
        }
      }
      
      // Apply the changes: find and replace the removed lines with added lines
      if (startLine >= 0 && removals.length > 0) {
        // Search for exact match starting from the specified line
        let matchStart = -1
        const searchEnd = Math.min(startLine + 10, lines.length - removals.length + 1)
        
        for (let i = Math.max(0, startLine - 5); i < searchEnd; i++) {
          let matches = true
          for (let j = 0; j < removals.length; j++) {
            if (i + j >= lines.length || lines[i + j] !== removals[j]) {
              matches = false
              break
            }
          }
          if (matches) {
            matchStart = i
            break
          }
        }
        
        if (matchStart >= 0) {
          // Replace the matched lines with additions
          lines.splice(matchStart, removals.length, ...additions)
        } else {
          console.warn(`Could not find exact match for diff at line ${startLine + 1}`)
        }
      } else if (startLine >= 0 && removals.length === 0 && additions.length > 0) {
        // Pure addition - insert at specified line
        lines.splice(startLine, 0, ...additions)
      }
    }
    
    return lines.join('\n')
  } catch (error) {
    console.error('Diff parsing error:', error)
    return sourceCode // Return original if parsing fails
  }
}


await safeSend(new Date() + ' start creating new version')

// Check for user-reported errors first
const userReports = await loadUserErrorReports()
const pendingReports = userReports.filter(report => report.status !== 'processed')

let source_response;
let taskType = 'normal_improvement';

if (pendingReports.length > 0) {
  taskType = 'user_error_fixing';
  await safeSend(new Date() + ' found ' + pendingReports.length + ' user-reported errors to fix')
  
  // Format user reports for the prompt
  const reportSummary = pendingReports.map(report => 
    `Error #${report.id}: ${report.description}\nReported by: ${report.username}\nTimestamp: ${report.timestamp}\n`
  ).join('\n---\n')
  
  const userErrorFixingPrompt = user_error_fix_prompt
    .replace('{{user_reports}}', reportSummary)
    .replace('{{source}}', original_source)
  
  source_response = await client.responses.create({
    model: 'gpt-5-mini',
    reasoning: { effort: "high" },
    input: [{
      role: 'user',
      content: userErrorFixingPrompt
    }],
    max_output_tokens: 16384
  })
  
} else {
  await safeSend(new Date() + ' no user-reported errors - proceeding with normal improvements')
  source_response = await client.responses.create({
    model: 'gpt-5-mini',
    input: [{
      role: 'user',
      content: source_prompt
    }],
    max_output_tokens: 16384
  })
}

await safeSend(new Date() + ' finished: ' + source_response.output_text.length + ' characters')

// Apply modifications using diff format
let source = applyDiffPatches(original_source, source_response.output_text)
await safeSend(new Date() + ' applied modifications using diff format')

// Validate critical patterns weren't removed
await safeSend(new Date() + ' validating critical code patterns...')
const validation = validateCriticalPatterns(source)

if (!validation.isValid) {
  await safeSend(new Date() + ' CRITICAL PATTERNS MISSING - reverting changes')
  await safeSend('Missing patterns: ' + validation.missing.join(', '))
  source = original_source // Revert to original
} else {
  await safeSend(new Date() + ' critical patterns validation: PASSED')
}

// Check for runtime errors before writing the file
await safeSend(new Date() + ' checking for runtime errors...')
const error_check_response = await client.responses.create({
  model: 'gpt-5-mini',
  reasoning: { effort: "high" },
  input: [{
    role: 'user',
    content: error_check_prompt + '\n\nCode to check:\n' + source
  }],
  max_output_tokens: 4096
})

const error_result = error_check_response.output_text.trim()
await safeSend(new Date() + ' error check result: ' + (error_result.includes('NO_ERRORS_FOUND') ? 'PASSED' : 'ISSUES FOUND'))

// If errors found, try to fix them using diff-style patches
if (!error_result.includes('NO_ERRORS_FOUND')) {
  const backup_source = source; // Keep backup
  
  const fix_prompt = diff_fix_prompt
    .replace('{{errors}}', error_result)
    .replace('{{source}}', source)
  
  const fix_response = await client.responses.create({
    model: 'gpt-5-mini',
    reasoning: { effort: "high" },
    input: [{
      role: 'user', 
      content: fix_prompt
    }],
    max_output_tokens: 8192
  })
  
  // Apply diff patches instead of replacing entire source
  const diffOutput = fix_response.output_text
  source = applyDiffPatches(source, diffOutput)
  await safeSend(new Date() + ' applied diff-style error fixes')
  
  // Re-check for errors after fix attempt
  const recheck_response = await client.responses.create({
    model: 'gpt-5-nano',
    input: [{
      role: 'user',
      content: error_check_prompt + '\n\nCode to check:\n' + source
    }],
    max_output_tokens: 2048
  })
  
  const recheck_result = recheck_response.output_text.trim()
  if (!recheck_result.includes('NO_ERRORS_FOUND')) {
    await safeSend(new Date() + ' error fixes failed, reverting to original')
    source = backup_source
  } else {
    // Also validate logical integrity after fixes
    const postFixValidation = validateCriticalPatterns(source)
    if (!postFixValidation.isValid) {
      await safeSend(new Date() + ' error fixes broke critical patterns, reverting')
      await safeSend('Broken patterns: ' + postFixValidation.missing.join(', '))
      source = backup_source
    } else {
      await safeSend(new Date() + ' error fixes successful and patterns intact')
    }
  }
}

// Final syntax validation
await safeSend(new Date() + ' final syntax validation...')
const syntax_check_response = await client.responses.create({
  model: 'gpt-5-nano',
  input: [{
    role: 'user',
    content: syntax_check_prompt + '\n\nCode to validate:\n' + source
  }],
  max_output_tokens: 512
})

const syntax_result = syntax_check_response.output_text.trim()
if (!syntax_result.includes('SYNTAX_VALID')) {
  await safeSend(new Date() + ' SYNTAX ERROR DETECTED: ' + syntax_result)
  // Don't write the file if syntax is invalid
  process.exit(1)
}

await safeSend(new Date() + ' syntax validation: PASSED')

// Final logical validation using AI
await safeSend(new Date() + ' performing comprehensive logical validation...')
const logical_validation_response = await client.responses.create({
  model: 'gpt-5-mini',
  reasoning: { effort: "high" },
  input: [{
    role: 'user',
    content: logical_validation_prompt + '\n\nCode to validate:\n' + source
  }],
  max_output_tokens: 2048
})

const logical_result = logical_validation_response.output_text.trim()
if (!logical_result.includes('LOGICAL_VALIDATION_PASSED')) {
  await safeSend(new Date() + ' LOGICAL ERRORS DETECTED - blocking deployment')
  await safeSend('Logical issues found: ' + logical_result)
  // Don't write the file if logical errors detected
  process.exit(1)
}

await safeSend(new Date() + ' logical validation: PASSED')
fs.writeFileSync('./workspace/main.mjs', source)

// Mark user reports as processed if this was an error-fixing run
if (taskType === 'user_error_fixing' && pendingReports.length > 0) {
  const allReports = await loadUserErrorReports()
  for (const report of pendingReports) {
    const reportIndex = allReports.findIndex(r => r.id === report.id)
    if (reportIndex >= 0) {
      allReports[reportIndex].status = 'processed'
      allReports[reportIndex].fixedAt = new Date().toISOString()
    }
  }
  await saveUserErrorReports(allReports)
  await safeSend(new Date() + ' marked ' + pendingReports.length + ' error reports as processed')
}

const package_response = await client.responses.create({
  model: 'gpt-5-mini',
  reasoning: { effort: "high" },
  text: { verbosity: "high" },
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

// Add context about task type for changelog
let changelogContext = changelog_prompt
if (taskType === 'user_error_fixing') {
  const fixedReportsInfo = pendingReports.map(r => `- ${r.description} (reported by ${r.username})`).join('\n')
  changelogContext += `\n\nIMPORTANT: This update fixes user-reported errors:\n${fixedReportsInfo}\n\nFocus the changelog on these specific fixes.`
}

const changelog_response = await client.responses.create({
  model: 'gpt-5-nano',
  reasoning: { effort: "low" },
  text: { verbosity: "medium" },
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
      content: changelogContext
    }
  ]
})

await safeSend({
  content: changelog_response.output_text,
  allowedMentions: {
    parse: []
  }
})

const commit_response = await client.responses.create({
  model: 'gpt-5-nano',
  reasoning: { effort: "low" },
  text: { verbosity: "low" },
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
