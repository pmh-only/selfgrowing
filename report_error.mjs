#!/usr/bin/env node

// User Error Reporting System
// Usage: node report_error.mjs "Error description here" [username]

import fs from 'fs'
import { randomUUID } from 'crypto'

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

async function addErrorReport(description, username = 'user') {
  if (!description || description.trim().length === 0) {
    console.error('❌ Error description is required')
    console.log('Usage: node report_error.mjs "Error description" [username]')
    process.exit(1)
  }

  const reports = await loadUserErrorReports()
  
  const newReport = {
    id: randomUUID(),
    description: description.trim(),
    username: username.trim(),
    timestamp: new Date().toISOString(),
    status: 'pending'
  }
  
  reports.push(newReport)
  await saveUserErrorReports(reports)
  
  console.log('✅ Error report submitted successfully!')
  console.log('📋 Report Details:')
  console.log('   ID:', newReport.id)
  console.log('   Description:', newReport.description)
  console.log('   Reporter:', newReport.username)
  console.log('   Status: Pending (will be processed in next automation cycle)')
  
  const pendingCount = reports.filter(r => r.status === 'pending').length
  console.log(`\n📊 Total pending reports: ${pendingCount}`)
  
  if (pendingCount === 1) {
    console.log('🔧 This is the only pending report - it will be prioritized in the next automation run!')
  } else {
    console.log('⏳ Your report has been added to the queue and will be processed with other pending reports.')
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const description = args[0]
const username = args[1] || 'user'

// Add the error report
addErrorReport(description, username).catch(console.error)